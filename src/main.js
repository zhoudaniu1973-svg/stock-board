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
let searchDebounceTimer = null;

const state = {
  query: "",
  watchlist: loadWatchlist(), // string[]
  quotesBySymbol: {}, // Record<symbol, Quote>
  searchResult: null, // Quote | null
  ui: { loading: false, message: null }, // UI status
};

function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[m]);
}

function isAShareSymbol(symbol) {
  const s = (symbol || "").toUpperCase();
  return /^\d{6}$/.test(s) || /\.SS$/.test(s) || /\.SZ$/.test(s) || /^SH/.test(s) || /^SZ/.test(s);
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => (typeof s === "string" ? s.toUpperCase() : null))
      .filter((s) => s && !isAShareSymbol(s)); // 过滤 A 股，不再请求
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
  // 禁止 A 股加入自选
  if (isAShareSymbol(sym)) return;
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
      const displayName = escapeHtml(s.name || s.symbol);
      const symbolText = escapeHtml(s.symbol);
      const errorText = escapeHtml(hasError ? s.error : "");

      return `
        <div class="stock-card">
          <div class="stock-header">
            <span class="symbol">${symbolText}</span>
            <span class="name">${displayName}</span>
            <button class="star-btn ${starred ? "active" : ""}" data-symbol="${symbolText}" data-name="${displayName}" aria-label="收藏">
              ${starred ? "★" : "☆"}
            </button>
          </div>
          <div class="stock-body">
            ${hasError
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
  const isQueryEmpty = state.query.trim() === "";
  const hasSearchResult = Boolean(state.searchResult);
  const showInitialEmpty = isQueryEmpty && !hasSearchResult;
  const showNotFound = !isQueryEmpty && !hasSearchResult && !state.ui.loading;

  const watchlistQuotes = state.watchlist
    .map((sym) => state.quotesBySymbol[sym])
    .filter(Boolean);

  // 1. Watchlist Container
  const watchlistContainer = document.querySelector("#watchlist-container");
  if (watchlistContainer) {
    const watchlistContent = state.watchlist.length
      ? watchlistQuotes.length
        ? `<div class="card-grid">${renderStockCards(watchlistQuotes)}</div>`
        : `<div class="watchlist-empty"><div class="empty-text">加载中...</div></div>`
      : `<div class="watchlist-empty">
          <div class="empty-title">暂无自选股</div>
          <div class="empty-text">点击星标添加</div>
        </div>`;

    watchlistContainer.innerHTML = `
      <section class="watchlist">
        <div class="section-header">
          <h2 class="section-title">我的自选股 (${state.watchlist.length})</h2>
        </div>
        ${watchlistContent}
      </section>
    `;
  }

  // 2. Search Result Container
  const searchResultContainer = document.querySelector("#search-result-container");
  if (searchResultContainer) {
    searchResultContainer.innerHTML = state.searchResult
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
  }

  // 3. Initial Empty Container
  const initialEmptyContainer = document.querySelector("#initial-empty-container");
  if (initialEmptyContainer) {
    if (showInitialEmpty) {
      initialEmptyContainer.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon">⬇</div>
          <div class="empty-title">搜索股票开始</div>
          <div class="empty-text">在上方搜索框输入股票代码或公司名</div>
        </div>
      `;
    } else if (showNotFound) {
      initialEmptyContainer.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon">🙁</div>
          <div class="empty-title">未找到</div>
          <div class="empty-text">请检查代码或公司名称后再试</div>
        </div>
      `;
    } else {
      initialEmptyContainer.innerHTML = "";
    }
  }

  // 4. Status Container
  const statusContainer = document.querySelector("#status-container");
  if (statusContainer) {
    const statusText = state.ui.message || (state.ui.loading ? "加载中..." : "");
    statusContainer.innerHTML = statusText ? `<div class="status-text">${statusText}</div>` : "";
  }
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

  app.addEventListener("input", (e) => {
    if (e.target && e.target.classList.contains("search-input")) {
      const value = e.target.value;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        handleSearch(value);
      }, 400); // debounce 400ms
    }
  });

  eventsBound = true;
}

async function refreshData(options = {}) {
  state.ui = { loading: true, message: options.silent ? null : "加载中..." };
  renderLayout();

  const updatedQuotes = { ...state.quotesBySymbol };

  try {
    const tasks = state.watchlist
      .filter((sym) => !isAShareSymbol(sym)) // 不请求 A 股
      .map(async (sym) => {
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
    if (isAShareSymbol(value)) {
      statusMessage = "仅支持美股/指数";
      state.searchResult = null;
      return;
    }
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
bindEventsOnce();
refreshData({ silent: true });
