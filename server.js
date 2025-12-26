const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const CACHE_TTL_MS = 30 * 1000; // 30s TTL
const cache = new Map();

const truncateDetail = (text = "", limit = 200) =>
  text.length > limit ? text.slice(0, limit) : text;

// 测试接口
app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

// 代理 Yahoo Finance
app.get("/stock/:symbol", async (req, res) => {
  const symbol = (req.params.symbol || "").trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: "Symbol is required" });
  }

  const now = Date.now();
  const cached = cache.get(symbol);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

  try {
    const response = await fetch(yahooUrl); // Node18原生fetch
    const status = response.status;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const textBody = await response.text();

    if (!response.ok) {
      return res
        .status(status)
        .json({
          error: "Upstream error",
          status,
          detail: truncateDetail(textBody),
        });
    }

    if (!contentType.includes("application/json")) {
      return res
        .status(502)
        .json({
          error: "Upstream returned non-JSON",
          detail: truncateDetail(textBody),
        });
    }

    let data;
    try {
      data = JSON.parse(textBody);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr);
      return res
        .status(502)
        .json({
          error: "Failed to parse upstream JSON",
          detail: truncateDetail(textBody),
        });
    }

    cache.set(symbol, { ts: now, payload: data });
    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
