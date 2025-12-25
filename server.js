const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

// 测试接口
app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

// 代理 Yahoo Finance
app.get("/stock/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

  try {
    const response = await fetch(yahooUrl);  // Node18原生fetch
    const data = await response.json();
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
