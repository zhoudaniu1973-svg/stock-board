// src/stock-card.js
export async function fetchStock(symbol) {
  // èµ°ä½ æœ¬åœ°çš?Node ä»£ç†ï¼Œè€Œä¸æ˜¯ç›´æŽ¥è¯·æ±?yahoo
  const base = import.meta.env.VITE_API_BASE || "http://localhost:3000";
  const url = `${base}/stock/${symbol}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const meta = json.chart.result[0].meta;

    const price = meta.regularMarketPrice;
    const prev = meta.previousClose;
    const change = price - prev;
    const changePercent = (change / prev) * 100;

    return {
      symbol,
      price,
      prevClose: prev,
      change,
      changePercent,
    };
  } catch (e) {
    console.error("Yahoo error", symbol, e);
    return null;
  }
}
