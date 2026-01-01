require("dotenv").config();
const FMP_API_KEY = process.env.FMP_API_KEY;

const express = require("express");
const cors = require("cors");
const iconv = require("iconv-lite"); // 用于新浪 API 的 GBK 解码

const app = express();
app.use(cors());

// Configs: TTL/LRU limit/rate-limit window are all env overridable.
const parseEnvInt = (key, fallback) => {
  const parsed = parseInt(process.env[key], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CACHE_TTL_MS = parseEnvInt("CACHE_TTL_MS", 60 * 1000); // TTL for cache freshness
const CACHE_CAPACITY = parseEnvInt("CACHE_CAPACITY", 200); // Max symbols to keep before LRU eviction
const RATE_LIMIT_WINDOW_MS = parseEnvInt("RATE_LIMIT_WINDOW_MS", 10 * 1000); // Time window for upstream rate limit
const RATE_LIMIT_MAX = parseEnvInt("RATE_LIMIT_MAX", 30); // Max upstream hits per window
const FMP_QUOTE_URL = "https://financialmodelingprep.com/stable/quote-short"; // Requires env FMP_API_KEY

const cache = new Map(); // LRU-ish: we reinsert on hit and evict oldest when exceeding capacity
const inFlight = new Map(); // In-flight deduplication per symbol (promise reuse)
const upstreamHits = []; // Timestamp queue for simple global rate limiting

const truncateDetail = (text = "", limit = 200) =>
  text.length > limit ? text.slice(0, limit) : text;

const normalizeSymbol = (raw = "") => raw.trim().toUpperCase(); // keep user-provided suffixes

const isAShareSymbol = (symbol) =>
  /^\d{6}$/.test(symbol) || /\.SS$/.test(symbol) || /\.SZ$/.test(symbol) || /^SH/.test(symbol) || /^SZ/.test(symbol);

const isFresh = (entry, now) => entry && now - entry.ts < CACHE_TTL_MS;

const getFreshFromCache = (symbol, now) => {
  const entry = cache.get(symbol);
  if (isFresh(entry, now)) {
    cache.delete(symbol); // move to end for LRU
    cache.set(symbol, entry);
    console.log(`[cache hit] ${symbol}`);
    return entry.payload;
  }
  return null;
};

const getAnyCache = (symbol) => cache.get(symbol)?.payload || null; // stale allowed

const setCache = (symbol, payload) => {
  cache.delete(symbol);
  cache.set(symbol, { ts: Date.now(), payload });
  if (cache.size > CACHE_CAPACITY) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    console.log(`[cache evict] ${oldestKey}`);
  }
};

const requestSlotAvailable = () => {
  // Sliding window rate limiter; prevents too many upstream hits
  const now = Date.now();
  while (upstreamHits.length && now - upstreamHits[0] > RATE_LIMIT_WINDOW_MS) {
    upstreamHits.shift();
  }
  if (upstreamHits.length >= RATE_LIMIT_MAX) {
    return false;
  }
  upstreamHits.push(now);
  return true;
};

const validateQuote = (quote) => {
  const price = Number(quote?.price);
  const change = Number(quote?.change);
  if (!Number.isFinite(price)) {
    const err = new Error("Upstream data missing price");
    err.httpStatus = 502;
    throw err;
  }
  if (!Number.isFinite(change)) {
    const err = new Error("Upstream data missing change");
    err.httpStatus = 502;
    throw err;
  }

  const previousClose = price - change;
  const percent = (change / previousClose) * 100;
  const t = new Date().toISOString();

  return { price, change, percent, t };
};

const fetchAndCache = async (symbol) => {
  console.log(`[upstream fetch] ${symbol}`);
  const url = new URL(FMP_QUOTE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", FMP_API_KEY);

  const res = await fetch(url);
  const status = res.status;
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`Upstream HTTP ${status}`);
    err.httpStatus = status;
    err.detail = text;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text || "");
  } catch (parseErr) {
    const err = new Error("Failed to parse upstream JSON");
    err.httpStatus = 502;
    err.detail = parseErr.message;
    throw err;
  }

  if (!Array.isArray(data) || data.length === 0) {
    const err = new Error("Upstream returned empty array");
    err.httpStatus = 502;
    throw err;
  }

  const { price, change, percent, t } = validateQuote(data[0]);
  const payload = { symbol, price, change, percent, t };
  setCache(symbol, payload);
  return payload;
};

const respondError = (res, status, message, detail) => {
  return res.status(status).json({
    error: message,
    detail: truncateDetail(detail || message),
  });
};

const respondCachedOr502 = (res, stalePayload, err) => {
  if (stalePayload) {
    return res.json({ ...stalePayload, cached: true });
  }
  const status = err?.httpStatus || err?.statusCode || 0;
  if (status && status !== 200) {
    return respondError(res, 502, "Upstream error", err?.detail || err?.message);
  }
  return respondError(res, 502, "Upstream error", err?.detail || err?.message);
};

// Health check
app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

// Financial Modeling Prep proxy with cache + in-flight reuse + rate limit
app.get("/stock/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol || "");
  if (!symbol) {
    return res.status(400).json({ error: "Symbol is required" });
  }
  if (isAShareSymbol(symbol)) {
    return res.status(400).json({ error: "A_SHARE_DISABLED" });
  }

  const now = Date.now();
  const fresh = getFreshFromCache(symbol, now);
  if (fresh) {
    return res.json(fresh);
  }

  if (inFlight.has(symbol)) {
    console.log(`[in-flight reuse] ${symbol}`);
    try {
      const payload = await inFlight.get(symbol);
      return res.json(payload);
    } catch (err) {
      const stalePayload = getAnyCache(symbol);
      return respondCachedOr502(res, stalePayload, err);
    }
  }

  console.log(`[cache miss] ${symbol}`);
  const stale = getAnyCache(symbol);
  if (!requestSlotAvailable()) {
    console.warn(`[rate limited] ${symbol}`);
    if (stale) {
      return res.json({ ...stale, stale: true });
    }
    return respondError(res, 429, "Rate limited", "Too many requests, try later");
  }

  const promise = fetchAndCache(symbol).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, promise);

  try {
    const payload = await promise;
    return res.json(payload);
  } catch (err) {
    const stalePayload = getAnyCache(symbol);
    return respondCachedOr502(res, stalePayload, err);
  }
});

// ==================== 新浪 API 代理 ====================

const SINA_API_BASE = "http://hq.sinajs.cn/list=";

/**
 * 判断股票代码所属市场并转换为新浪格式
 */
const formatSinaSymbol = (symbol) => {
  const s = (symbol || "").trim().toUpperCase();

  // 已带前缀的情况
  if (s.startsWith("SH") && /^SH\d{6}$/.test(s)) return `sh${s.slice(2)}`;
  if (s.startsWith("SZ") && /^SZ\d{6}$/.test(s)) return `sz${s.slice(2)}`;
  if (s.startsWith("GB_")) return s.toLowerCase();

  // 纯 6 位数字判断（A 股）
  if (/^\d{6}$/.test(s)) {
    const firstDigit = s[0];
    if (["6", "9"].includes(firstDigit)) return `sh${s}`;
    if (["0", "2", "3"].includes(firstDigit)) return `sz${s}`;
    return `sh${s}`;
  }

  // 后缀格式
  if (/\.SS$/.test(s) || /\.SH$/.test(s)) return `sh${s.replace(/\.(SS|SH)$/, "")}`;
  if (/\.SZ$/.test(s)) return `sz${s.replace(/\.SZ$/, "")}`;

  // 其他视为美股
  return `gb_${s.toLowerCase()}`;
};

/**
 * 解析新浪 A 股数据
 */
const parseAShareData = (dataString, sinaSymbol) => {
  const fields = dataString.split(",");
  if (fields.length < 10) return null;

  const stockName = fields[0] || "";
  const openPrice = parseFloat(fields[1]);
  const prevClose = parseFloat(fields[2]);
  const currentPrice = parseFloat(fields[3]);
  const highPrice = parseFloat(fields[4]);
  const lowPrice = parseFloat(fields[5]);
  const volume = parseInt(fields[8], 10);
  const amount = parseFloat(fields[9]);
  const tradeDate = fields[30] || "";
  const tradeTime = fields[31] || "";

  const price = currentPrice || prevClose;
  if (isNaN(price) || price === 0) return null;

  const change = isNaN(prevClose) ? 0 : (price - prevClose);
  const changePercent = isNaN(prevClose) || prevClose === 0 ? 0 : ((change / prevClose) * 100);
  const symbol = sinaSymbol.replace(/^(sh|sz)/i, "").toUpperCase();

  return {
    symbol,
    name: stockName,
    price,
    change: parseFloat(change.toFixed(2)),
    percent: parseFloat(changePercent.toFixed(2)),
    tradeTime: `${tradeDate} ${tradeTime}`.trim(),
    openPrice: openPrice || null,
    highPrice: highPrice || null,
    lowPrice: lowPrice || null,
    prevClose: prevClose || null,
    volume: volume || null,
    amount: amount || null,
    market: sinaSymbol.startsWith("sh") ? "SH" : "SZ",
    source: "sina",
    t: new Date().toISOString(),
  };
};

/**
 * 解析新浪美股数据
 */
const parseUSStockData = (dataString, sinaSymbol) => {
  const fields = dataString.split(",");
  if (fields.length < 5) return null;

  const stockName = fields[0] || "";
  const currentPrice = parseFloat(fields[1]);
  const changePercent = parseFloat(fields[2]);
  const tradeTime = fields[3] || "";
  const priceChange = parseFloat(fields[4]);

  if (isNaN(currentPrice)) return null;

  // 优先从 sinaSymbol 提取代码（更可靠），字段 14 可能有偏差
  const symbol = sinaSymbol.replace("gb_", "").toUpperCase();

  return {
    symbol,
    name: stockName,
    price: currentPrice,
    change: isNaN(priceChange) ? 0 : priceChange,
    percent: isNaN(changePercent) ? 0 : changePercent,
    tradeTime,
    openPrice: parseFloat(fields[6]) || null,
    highPrice: parseFloat(fields[7]) || null,
    week52High: parseFloat(fields[8]) || null,
    week52Low: parseFloat(fields[9]) || null,
    marketCap: fields[10] || null,
    pe: parseFloat(fields[11]) || null,
    volume: fields[13] || null,
    market: "US",
    source: "sina",
    t: new Date().toISOString(),
  };
};

/**
 * 解析新浪 API 响应
 */
const parseSinaResponse = (rawText) => {
  const match = rawText.match(/var\s+hq_str_([^=]+)="([^"]*)"/);
  if (!match) return null;

  const sinaSymbol = match[1];
  const dataString = match[2];
  if (!dataString || dataString.trim() === "") return null;

  if (sinaSymbol.startsWith("sh") || sinaSymbol.startsWith("sz")) {
    return parseAShareData(dataString, sinaSymbol);
  } else if (sinaSymbol.startsWith("gb_")) {
    return parseUSStockData(dataString, sinaSymbol);
  }
  return null;
};

/**
 * 从新浪 API 获取股票数据
 */
const fetchSinaStock = async (symbol) => {
  const sinaSymbol = formatSinaSymbol(symbol);
  const url = `${SINA_API_BASE}${sinaSymbol}`;

  console.log(`[sina fetch] ${symbol} -> ${url}`);

  const response = await fetch(url, {
    headers: {
      "Referer": "https://finance.sina.com.cn",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Sina API HTTP ${response.status}`);
  }

  // 使用 iconv-lite 解码 GBK
  const buffer = await response.arrayBuffer();
  const decodedText = iconv.decode(Buffer.from(buffer), "gbk");

  const parsed = parseSinaResponse(decodedText);
  if (!parsed) {
    throw new Error("解析失败或股票代码无效");
  }

  return parsed;
};

// 新浪股票代理路由（支持 A 股和美股）
app.get("/sina/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol || "");
  if (!symbol) {
    return res.status(400).json({ error: "Symbol is required" });
  }

  try {
    const data = await fetchSinaStock(symbol);
    return res.json(data);
  } catch (err) {
    console.error(`[sina error] ${symbol}:`, err.message);
    return respondError(res, 502, "Sina API error", err.message);
  }
});

// 新浪批量查询路由
app.get("/sina-batch", async (req, res) => {
  const symbolsParam = req.query.symbols || "";
  const symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  if (symbols.length === 0) {
    return res.status(400).json({ error: "Symbols are required" });
  }

  if (symbols.length > 50) {
    return res.status(400).json({ error: "Too many symbols, max 50" });
  }

  // 批量请求新浪 API
  const sinaSymbols = symbols.map(formatSinaSymbol).join(",");
  const url = `${SINA_API_BASE}${sinaSymbols}`;

  console.log(`[sina batch] ${symbols.length} symbols`);

  try {
    const response = await fetch(url, {
      headers: {
        "Referer": "https://finance.sina.com.cn",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`Sina API HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const decodedText = iconv.decode(Buffer.from(buffer), "gbk");

    // 解析多行结果
    const lines = decodedText.split("\n").filter(line => line.trim());
    const results = [];

    for (const line of lines) {
      const parsed = parseSinaResponse(line);
      if (parsed) {
        results.push(parsed);
      }
    }

    return res.json({ stocks: results, count: results.length });
  } catch (err) {
    console.error("[sina batch error]:", err.message);
    return respondError(res, 502, "Sina API error", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
