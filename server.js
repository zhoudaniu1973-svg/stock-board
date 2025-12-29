require("dotenv").config();
const FMP_API_KEY = process.env.FMP_API_KEY;

const express = require("express");
const cors = require("cors");

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
