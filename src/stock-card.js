// src/stock-card.js
export async function fetchStock(symbol) {
  const base = import.meta.env.VITE_API_BASE || "http://localhost:3000";
  const url = `${base}/stock/${symbol}`;

  try {
    const res = await fetch(url);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();

    if (!res.ok) {
      try {
        const errJson = JSON.parse(text || "{}");
        const detail = errJson.detail || errJson.error || text;
        throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
      } catch (_parseErr) {
        throw new Error(text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`);
      }
    }

    if (!contentType.includes("application/json")) {
      throw new Error("Upstream returned non-JSON");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (_parseErr) {
      throw new Error("Failed to parse upstream JSON");
    }

    const price = Number(data.price);
    const change = Number(data.change);
    const percent = Number(data.percent);
    const prevClose = isFinite(price) && isFinite(change) ? price - change : null;

    return {
      symbol,
      price,
      prevClose,
      change,
      changePercent: percent,
    };
  } catch (e) {
    console.error("Fetch stock error", symbol, e);
    return { error: e.message || "Fetch failed" };
  }
}
