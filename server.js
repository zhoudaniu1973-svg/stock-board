require("dotenv").config();


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

// Sina Finance proxy with cache + in-flight reuse + rate limit
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

  // Use Sina API
  const promise = fetchSinaStock(symbol).then(data => {
    // Normalize fields for compatibility
    // Sina API returns: price, change, percent (which is changePercent)
    // Frontend expects: price, change, percent

    // Ensure percent field exists (it should be in parsed data)
    if (data.percent === undefined && data.changePercent !== undefined) {
      data.percent = data.changePercent;
    }

    // Cache the normalized payload
    setCache(symbol, data);
    return data;
  }).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, promise);

  try {
    const payload = await promise;
    return res.json(payload);
  } catch (err) {
    const stalePayload = getAnyCache(symbol);
    return respondCachedOr502(res, stalePayload, err);
  }
});

// ==================== 股票搜索建议 API ====================

const SINA_SUGGEST_URL = "https://suggest3.sinajs.cn/suggest/type=&key=";

/**
 * 解析新浪搜索建议返回数据
 * 格式: var suggestdata="名称,类型,代码,新浪代码,拼音,权重;..."
 */
const parseSuggestResponse = (rawText) => {
  // 匹配 var suggestdata_xxx="..."
  const match = rawText.match(/var\s+\w+="([^"]*)"/);
  if (!match || !match[1]) return [];

  const dataString = match[1];
  if (!dataString.trim()) return [];

  const items = dataString.split(";").filter(Boolean);
  const suggestions = [];

  for (const item of items) {
    const fields = item.split(",");
    if (fields.length < 4) continue;

    const name = fields[0];       // 股票名称
    const typeCode = fields[1];   // 类型码：11=A股, 74=美股
    const code = fields[2];       // 股票代码
    const sinaCode = fields[3];   // 新浪代码格式

    // 判断市场类型
    let market = "US";
    if (sinaCode.startsWith("sh")) market = "SH";
    else if (sinaCode.startsWith("sz")) market = "SZ";
    else if (sinaCode.startsWith("gb_")) market = "US";

    suggestions.push({
      symbol: code.toUpperCase(),
      name,
      market,
      sinaCode,
      typeCode,
    });
  }

  return suggestions;
};

// 重定向根路径到 index.html (SPA 支持)
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// 股票搜索建议路由
app.get("/search", async (req, res) => {
  const keyword = (req.query.q || "").trim();

  if (!keyword) {
    return res.json({ suggestions: [], keyword: "" });
  }

  const url = `${SINA_SUGGEST_URL}${encodeURIComponent(keyword)}&name=suggestdata`;

  console.log(`[search] 关键词: ${keyword}`);

  try {
    const response = await fetch(url, {
      headers: {
        "Referer": "https://finance.sina.com.cn",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`Sina suggest API HTTP ${response.status}`);
    }

    // 新浪建议 API 返回 GBK 编码，需要使用 iconv-lite 解码
    const buffer = await response.arrayBuffer();
    const text = iconv.decode(Buffer.from(buffer), "gbk");
    const suggestions = parseSuggestResponse(text);

    console.log(`[search] 找到 ${suggestions.length} 个结果`);

    return res.json({
      suggestions: suggestions.slice(0, 10), // 最多返回 10 条
      keyword
    });
  } catch (err) {
    console.error("[search error]:", err.message);
    return respondError(res, 502, "Search API error", err.message);
  }
});

// ==================== 新浪 API 代理 ====================

const SINA_API_BASE = "http://hq.sinajs.cn/list=";

/**
 * 判断股票代码所属市场并转换为新浪格式
 */
const formatSinaSymbol = (symbol) => {
  let s = (symbol || "").trim().toUpperCase();

  // 移除前导点（例如 .IXIC -> IXIC）
  if (s.startsWith(".")) {
    s = s.slice(1);
  }

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
