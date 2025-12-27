const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

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

const normalizeSymbol = (raw = "") => {
  // Normalize: trim + uppercase; don't auto-append .SS/.SZ unless user provides it
  return raw.trim().toUpperCase();
};

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
  // 修正点 3: 仅强制校验 price；change/percent 可为空并原样返回
  const price = quote?.regularMarketPrice;
  const change = Number.isFinite(quote?.regularMarketChange)
    ? quote.regularMarketChange
    : null;
  const percent = Number.isFinite(quote?.regularMarketChangePercent)
    ? quote.regularMarketChangePercent
    : null;
  if (!Number.isFinite(price)) {
    const err = new Error("Upstream data missing price");
    err.httpStatus = 502;
    err.expose = true;
    throw err;
  }
  const timeVal = quote?.regularMarketTime;
  let t = null;
  if (timeVal instanceof Date && !Number.isNaN(timeVal.getTime())) {
    t = timeVal.toISOString();
  } else if (Number.isFinite(timeVal)) {
    const ms = timeVal < 1e12 ? timeVal * 1000 : timeVal;
    t = new Date(ms).toISOString();
  } else if (typeof timeVal === "string") {
    const parsed = Date.parse(timeVal);
    if (!Number.isNaN(parsed)) {
      t = new Date(parsed).toISOString();
    }
  }
  return { price, change, percent, t };
};

const fetchAndCache = async (symbol) => {
  console.log(`[upstream fetch] ${symbol}`);
  const quote = await yahooFinance.quote(symbol);
  const { price, change, percent, t } = validateQuote(quote);
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

// Health check
app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

// Yahoo Finance proxy with cache + in-flight reuse + rate limit
app.get("/stock/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol || "");
  if (!symbol) {
    return res.status(400).json({ error: "Symbol is required" });
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
      const status = err.httpStatus || err.statusCode || 502;
      return respondError(res, status, "Upstream error", err.message);
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

  // 修正点 2: 先登记 inFlight，再 await；移除无意义 catch，确保 finally 删除
  const promise = fetchAndCache(symbol).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, promise);

  try {
    const payload = await promise;
    return res.json(payload);
  } catch (err) {
    const statusCode =
      err.httpStatus ||
      err.statusCode ||
      (err.name === "HTTPError" && err.statusCode) ||
      502;

    // 修正点 1: 502 原样返回；仅不可达/5xx 映射为 503；429 保持
    if (statusCode === 429) {
      return respondError(res, 429, "Upstream rate limited", err.message);
    }
    if (statusCode === 502) {
      return respondError(res, 502, "Upstream error", err.message);
    }
    if (statusCode >= 500) {
      return respondError(res, 503, "Upstream unavailable", err.message);
    }
    return respondError(res, statusCode, "Upstream error", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
