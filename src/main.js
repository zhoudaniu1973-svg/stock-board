import "./style.css";
import { fetchStock } from "./stock-card.js";

const STOCK_LIST = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "NVDA", name: "NVIDIA" },
];

const WATCHLIST_KEY = "stock-board:watchlist";
let eventsBound = false;

const state = {
  query: "",
  watchlist: loadWatchlist(), // string[]
  quotesBySymbol: {}, // Record<symbol, Quote>
  searchResult: null, // Quote | null
  ui: { loading: false, message: null }, // UI status
};

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => (typeof s === "string" ? s.toUpperCase() : null))
      .filter(Boolean);
  } catch (err) {
    console.warn("Failed to load watchlist", err);
    return [];
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(state.watchlist));
  } catch (err) {
    console.warn("Failed to save watchlist", err);
  }
}

function isInWatchlist(symbol) {
  return state.watchlist.includes(symbol.toUpperCase());
}

function upsertWatchlist(symbol, quote) {
  const sym = symbol.toUpperCase();
  if (!isInWatchlist(sym)) {
    state.watchlist.push(sym);
    saveWatchlist();
  }
  if (quote) {
    state.quotesBySymbol[sym] = quote;
  }
}

function removeFromWatchlist(symbol) {
  const sym = symbol.toUpperCase();
  state.watchlist = state.watchlist.filter((s) => s !== sym);
  saveWatchlist();
  delete state.quotesBySymbol[sym];
}

function findStockMeta(input) {
  const upper = input.toUpperCase();
  const lower = input.toLowerCase();
  const bySymbol = STOCK_LIST.find((item) => item.symbol.toUpperCase() === upper);
  if (bySymbol) return bySymbol;
  const byNameContains = STOCK_LIST.find((item) =>
    item.name.toLowerCase().includes(lower)
  );
  if (byNameContains) return byNameContains;
  return { symbol: upper, name: upper };
}

function buildSearchDebugReport(query, stockList) {
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();

  const checks = stockList.map((item) => {
    const matchSymbol = item.symbol.toUpperCase() === upper;
    const matchName = item.name.toLowerCase().includes(lower) && lower.length > 0;
    return {
      symbol: item.symbol,
      name: item.name,
      matchSymbol,
      matchName,
    };
  });

  const matched = checks.find((c) => c.matchSymbol || c.matchName);

  let result = { type: "not_found" };
  if (matched) {
    result = { type: "meta_match", symbol: matched.symbol, name: matched.name };
  }

  return {
    query,
    normalizedQuery: { upper, lower },
    checks,
    result,
  };
}

function updateDebugPanel(report) {
  const el = document.querySelector("#debugOutput");
  if (!el) return;
  el.textContent = JSON.stringify(report, null, 2);
}

function renderStockCards(stocks) {
  return stocks
    .map((s) => {
      const hasError = Boolean(s.error);
      const up = !hasError && s.change >= 0;
      const changeClass = hasError ? "change" : up ? "change up" : "change down";
      const arrow = hasError ? "--" : up ? "▲" : "▼";
      const starred = isInWatchlist(s.symbol);
      const priceValue = Number.isFinite(s.price) ? s.price : 0;
      const changeValue = Number.isFinite(s.change) ? s.change : 0;
      const percentValue = Number.isFinite(s.percent) ? s.percent : 0;
      const displayName = s.name || s.symbol;
      const errorText = hasError ? s.error : "";

      return `
        <div class="stock-card">
          <div class="stock-header">
            <span class="symbol">${s.symbol}</span>
            <span class="name">${displayName}</span>
            <button class="star-btn ${starred ? "active" : ""}" data-symbol="${s.symbol}" data-name="${s.name}" aria-label="收藏">
              ${starred ? "★" : "☆"}
            </button>
          </div>
          <div class="stock-body">
            ${
              hasError
                ? `<div class="price-row"><span class="price">${errorText}</span></div>
                   <div class="change-row ${changeClass}">
                     <span class="change-chip">--</span>
                     <span>--</span>
                   </div>`
                : `<div class="price-row">
                     <span class="price">$${priceValue.toFixed(2)}</span>
                   </div>
                   <div class="change-row ${changeClass}">
                     <span class="change-chip">${arrow} ${changeValue.toFixed(2)}</span>
                     <span>${percentValue.toFixed(2)}%</span>
                   </div>`
            }
          </div>
        </div>
      `;
    })
    .join("");
}

function renderLayout() {
  const app = document.querySelector("#app");

  const isQueryEmpty = state.query.trim() === "";
  const hasSearchResult = Boolean(state.searchResult);
  const showInitialEmpty = isQueryEmpty && !hasSearchResult;
  const showNotFound = !isQueryEmpty && !hasSearchResult && !state.ui.loading;

  const watchlistQuotes = state.watchlist
    .map((sym) => state.quotesBySymbol[sym])
    .filter(Boolean);

  const watchlistContent = state.watchlist.length
    ? watchlistQuotes.length
      ? `<div class="card-grid">${renderStockCards(watchlistQuotes)}</div>`
      : `<div class="watchlist-empty"><div class="empty-text">加载中...</div></div>`
    : `<div class="watchlist-empty">
        <div class="empty-title">暂无自选股</div>
        <div class="empty-text">点击星标添加</div>
      </div>`;

  const searchSection = state.searchResult
    ? `
      <section class="search-result">
        <div class="section-header">
          <h2 class="section-title">搜索结果</h2>
        </div>
        <div class="card-grid single">
          ${renderStockCards([state.searchResult])}
        </div>
      </section>
    `
    : "";

  const initialEmptyCard = showInitialEmpty
    ? `
      <div class="empty-card">
        <div class="empty-icon">↗</div>
        <div class="empty-title">搜索股票开始</div>
        <div class="empty-text">在上方搜索框输入股票代码或公司名称</div>
      </div>
    `
    : "";

  const notFoundCard = showNotFound
    ? `
      <div class="empty-card">
        <div class="empty-icon">🙁</div>
        <div class="empty-title">未找到</div>
        <div class="empty-text">请检查代码或公司名称后再试</div>
      </div>
    `
    : "";

  const statusText = state.ui.message || (state.ui.loading ? "加载中..." : "");

  app.innerHTML = `
    <div class="page">
      <header class="top-bar">
        <div class="top-icon">☼</div>
        <div class="top-title">股票数据可视化工具</div>
        <button class="icon-button" data-action="refresh" aria-label="刷新">
          ↻
        </button>
      </header>

      <section class="hero">
        <div class="hero-icon">↗</div>
        <h1 class="hero-title">股票数据可视化</h1>
      </section>

      <section class="search-section">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            type="text"
            class="search-input"
            placeholder="搜索股票代码或公司名..."
            aria-label="搜索股票"
            value="${state.query}"
          />
        </div>
      </section>

      ${searchSection}
      ${initialEmptyCard}
      ${notFoundCard}

      <section class="watchlist">
        <div class="section-header">
          <h2 class="section-title">我的自选股 (${state.watchlist.length})</h2>
        </div>
        ${watchlistContent}
      </section>

      ${statusText ? `<div class="status-text">${statusText}</div>` : ""}
    </div>
  `;

  bindEventsOnce();
}

function bindEventsOnce() {
  if (eventsBound) return;
  const app = document.querySelector("#app");
  if (!app) return;

  app.addEventListener("click", (e) => {
    const refreshBtn = e.target.closest('[data-action="refresh"]');
    if (refreshBtn) {
      refreshData();
      return;
    }

    const starBtn = e.target.closest(".star-btn");
    if (starBtn) {
      const symbol = starBtn.dataset.symbol;
      const name = starBtn.dataset.name;
      if (!symbol) return;
      if (isInWatchlist(symbol)) {
        removeFromWatchlist(symbol);
      } else {
        const quote =
          (state.searchResult && state.searchResult.symbol === symbol && state.searchResult) ||
          state.quotesBySymbol[symbol];
        upsertWatchlist(
          symbol,
          quote || { symbol, name: name || symbol, price: 0, change: 0, percent: 0 }
        );
      }
      refreshData({ silent: true });
    }
  });

  app.addEventListener("keydown", (e) => {
    const target = e.target;
    if (
      target &&
      target.classList &&
      target.classList.contains("search-input") &&
      e.key === "Enter"
    ) {
      handleSearch(target.value);
    }
  });

  eventsBound = true;
}

async function refreshData(options = {}) {
  state.ui = { loading: true, message: options.silent ? null : "加载中..." };
  renderLayout();

  const updatedQuotes = { ...state.quotesBySymbol };

  try {
    const tasks = state.watchlist.map(async (sym) => {
      const meta = findStockMeta(sym);
      const result = await fetchStock(sym);
      return { sym, meta, result };
    });

    const settled = await Promise.allSettled(tasks);
    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { sym, meta, result } = entry.value;
        if (result && !result.error) {
          updatedQuotes[sym] = {
            symbol: sym,
            name: meta.name || sym,
            price: result.price,
            change: result.change,
            percent: result.changePercent,
          };
        } else {
          updatedQuotes[sym] = {
            symbol: sym,
            name: meta.name || sym,
            price: 0,
            change: 0,
            percent: 0,
            error: (result && result.error) || "获取失败",
          };
        }
      } else {
        const sym = entry.reason && entry.reason.sym ? entry.reason.sym : "未知";
        const meta = findStockMeta(sym);
        updatedQuotes[sym] = {
          symbol: sym,
          name: meta.name || sym,
          price: 0,
          change: 0,
          percent: 0,
          error: "获取失败",
        };
      }
    }
  } finally {
    state.quotesBySymbol = updatedQuotes;
    state.ui = { loading: false, message: null };
    renderLayout();
  }
}

async function handleSearch(rawInput) {
  const value = rawInput.trim();
  state.query = value;

  let report = buildSearchDebugReport(value, STOCK_LIST);
  let statusMessage = null;

  if (!value) {
    state.searchResult = null;
    state.ui = { loading: false, message: null };
    updateDebugPanel(report);
    renderLayout();
    return;
  }

  state.ui = { loading: true, message: "搜索中..." };
  state.searchResult = null;
  updateDebugPanel(report);
  renderLayout();

  try {
    const meta = findStockMeta(value);
    const result = await fetchStock(meta.symbol);
    const matched = report.checks.find((c) => c.matchSymbol || c.matchName);

    if (result && !result.error) {
      const quote = {
        symbol: meta.symbol.toUpperCase(),
        name: meta.name,
        price: result.price,
        change: result.change,
        percent: result.changePercent,
      };
      state.searchResult = quote;
      state.quotesBySymbol[quote.symbol] = quote;
      report.result = matched
        ? { type: "meta_match", symbol: matched.symbol, name: matched.name }
        : { type: "api_fallback", symbol: meta.symbol.toUpperCase(), name: meta.name };
      statusMessage = null;
    } else {
      const errorText = (result && result.error) || "获取失败";
      if (matched) {
        const fallbackQuote = {
          symbol: matched.symbol.toUpperCase(),
          name: matched.name,
          price: 0,
          change: 0,
          percent: 0,
          error: errorText,
        };
        state.searchResult = fallbackQuote;
        state.quotesBySymbol[fallbackQuote.symbol] = fallbackQuote;
        report.result = { type: "meta_match", symbol: matched.symbol, name: matched.name };
      } else {
        state.searchResult = null;
        report.result = { type: "not_found" };
      }
      statusMessage = errorText;
    }
  } finally {
    state.ui = { loading: false, message: statusMessage };
    updateDebugPanel(report);
    renderLayout();
  }
}

// 初始加载
refreshData({ silent: true });
