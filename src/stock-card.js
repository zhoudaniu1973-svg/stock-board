// src/stock-card.js
// 股票数据获取模块 - 支持 FMP API 和新浪 API

const API_BASE = import.meta.env.VITE_API_BASE;

/**
 * 判断是否为 A 股代码
 * @param {string} symbol - 股票代码
 * @returns {boolean}
 */
function isAShareSymbol(symbol) {
  const s = (symbol || "").toUpperCase();
  // 6 位数字、或带 SH/SZ/SS 前缀/后缀的都是 A 股
  return (
    /^\d{6}$/.test(s) ||
    /^SH\d{6}$/.test(s) ||
    /^SZ\d{6}$/.test(s) ||
    /\.SS$/.test(s) ||
    /\.SZ$/.test(s) ||
    /\.SH$/.test(s)
  );
}



/**
 * 从新浪 API 获取股票数据（支持 A 股和美股）
 * @param {string} symbol - 股票代码
 * @returns {Promise<Object>}
 */
async function fetchFromSina(symbol) {
  const url = `${API_BASE}/sina/${symbol}`;

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
      symbol: data.symbol || symbol,
      name: data.name || symbol, // 新浪返回中文名称
      price,
      prevClose: data.prevClose || prevClose,
      change,
      changePercent: percent,
      market: data.market, // SH / SZ / US
      tradeTime: data.tradeTime,
      // 详情页需要的额外字段
      openPrice: data.openPrice,
      highPrice: data.highPrice,
      lowPrice: data.lowPrice,
      volume: data.volume,
      amount: data.amount,
      source: "sina",
    };
  } catch (e) {
    console.error("Fetch Sina error", symbol, e);
    return { error: e.message || "Fetch failed" };
  }
}

/**
 * 批量从新浪 API 获取股票数据
 * @param {string[]} symbols - 股票代码数组
 * @returns {Promise<Object[]>}
 */
export async function fetchStockBatch(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return [];
  }

  const url = `${API_BASE}/sina-batch?symbols=${symbols.join(",")}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const stocks = data.stocks || [];

    return stocks.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      price: Number(item.price),
      prevClose: item.prevClose || null,
      change: Number(item.change),
      changePercent: Number(item.percent),
      market: item.market,
      tradeTime: item.tradeTime,
      source: "sina",
    }));
  } catch (e) {
    console.error("Fetch batch error", e);
    // 回退到单个请求
    return Promise.all(symbols.map((s) => fetchFromSina(s)));
  }
}

/**
 * 获取单只股票数据（使用新浪 API）
 * 
 * @param {string} symbol - 股票代码
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>}
 */
export async function fetchStock(symbol, options = {}) {
  // 始终使用新浪 API
  return fetchFromSina(symbol);
}

// 导出工具函数
export { isAShareSymbol, fetchFromSina };
