const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const CACHE_TTL_MS = 60 * 1000; // 60s TTL
const cache = new Map();

const truncateDetail = (text = "", limit = 200) =>
  text.length > limit ? text.slice(0, limit) : text;

// Test endpoint
app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

// Proxy mairui real-time A-share quotes
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

  const licence = process.env.MAIRUI_LICENCE;
  if (!licence) {
    return res.status(500).json({ error: "MAIRUI_LICENCE is not set" });
  }

  const apiUrl = `https://api.mairuiapi.com/hsstock/real/time/${symbol}/${licence}`;

  try {
    const response = await fetch(apiUrl); // Node18 built-in fetch
    const status = response.status;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const textBody = await response.text();

    if (!response.ok) {
      return res.status(status).json({
        error: "Upstream error",
        status,
        detail: truncateDetail(textBody),
      });
    }

    if (!contentType.includes("application/json")) {
      return res.status(502).json({
        error: "Upstream returned non-JSON",
        detail: truncateDetail(textBody),
      });
    }

    let data;
    try {
      data = JSON.parse(textBody);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr);
      return res.status(502).json({
        error: "Failed to parse upstream JSON",
        detail: truncateDetail(textBody),
      });
    }

    const payload = {
      symbol,
      price: data.p,
      change: data.ud,
      percent: data.pc,
      t: data.t,
    };

    cache.set(symbol, { ts: now, payload });
    return res.json(payload);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
