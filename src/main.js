import "./style.css";
import { fetchStock } from "./stock-card.js";

const STOCK_LIST = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "NVDA", name: "NVIDIA" },
];

const WATCHLIST_KEY = "stock-board:watchlist";
const QUOTES_CACHE_KEY = "stock-board:quotes-cache"; // 缓存行情数据
let eventsBound = false;
let searchDebounceTimer = null;
let suggestDebounceTimer = null; // 搜索建议防抖计时器

// 从 localStorage 加载缓存的行情数据
function loadQuotesCache() {
  try {
    const raw = localStorage.getItem(QUOTES_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch (err) {
    console.warn("Failed to load quotes cache", err);
    return {};
  }
}

// 保存行情数据到 localStorage
function saveQuotesCache() {
  try {
    localStorage.setItem(QUOTES_CACHE_KEY, JSON.stringify(state.quotesBySymbol));
  } catch (err) {
    console.warn("Failed to save quotes cache", err);
  }
}

const state = {
  query: "",
  watchlist: loadWatchlist(), // string[]
  quotesBySymbol: loadQuotesCache(), // 启动时立即从缓存加载行情数据
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
      .filter(Boolean); // 不再过滤 A 股，新浪 API 支持
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
  // 现在支持 A 股加入自选（使用新浪 API）
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

/**
 * 获取股票走势图 URL
 * A 股：分时图，美股：日 K 线图
 */
function getChartUrl(symbol, market) {
  const sym = (symbol || "").toUpperCase();

  if (market === "SH") {
    // 上证 A 股分时图
    return `http://image.sinajs.cn/newchart/min/n/sh${sym}.gif`;
  } else if (market === "SZ") {
    // 深证 A 股分时图
    return `http://image.sinajs.cn/newchart/min/n/sz${sym}.gif`;
  } else {
    // 美股日 K 线图
    return `http://image.sinajs.cn/newchart/usstock/daily/${sym.toLowerCase()}.gif`;
  }
}

function renderStockCards(stocks, options = {}) {
  const { showChart = false } = options; // 默认不显示走势图（自选股列表）

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

      // 根据市场类型选择货币符号：A 股用 ¥，美股用 $
      const isAShare = s.market === "SH" || s.market === "SZ";
      const currencySymbol = isAShare ? "¥" : "$";

      // 走势图 URL
      const chartUrl = getChartUrl(s.symbol, s.market);
      const chartLabel = isAShare ? "分时" : "日K";

      // 走势图 HTML（仅在需要时显示）
      const chartHtml = showChart ? `
        <div class="stock-chart">
          <img src="${chartUrl}" alt="${chartLabel}走势图" loading="lazy" onerror="this.style.display='none'" />
        </div>
      ` : "";

      return `
        <div class="stock-card" data-action="open-detail" data-symbol="${symbolText}">
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
                     <span class="price">${currencySymbol}${priceValue.toFixed(2)}</span>
                   </div>
                   <div class="change-row ${changeClass}">
                     <span class="change-chip">${arrow} ${changeValue.toFixed(2)}</span>
                     <span>${percentValue.toFixed(2)}%</span>
                   </div>${chartHtml}`
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
        ? `<div class="card-grid">${renderStockCards(watchlistQuotes, { showChart: false })}</div>`
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
            ${renderStockCards([state.searchResult], { showChart: true })}
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

// ==================== 股票详情弹窗 ====================

/**
 * 打开股票详情弹窗
 */
function openStockDetail(symbol) {
  const quote = state.quotesBySymbol[symbol] || state.searchResult;
  if (!quote || quote.symbol !== symbol) {
    console.warn("[detail] 未找到股票数据:", symbol);
    return;
  }

  const modal = document.querySelector("#stock-detail-modal");
  const content = document.querySelector("#stock-detail-content");
  if (!modal || !content) return;

  content.innerHTML = renderStockDetail(quote);
  modal.classList.add("active");
  document.body.style.overflow = "hidden"; // 防止背景滚动
}

/**
 * 关闭股票详情弹窗
 */
function closeStockDetail() {
  const modal = document.querySelector("#stock-detail-modal");
  if (modal) {
    modal.classList.remove("active");
    document.body.style.overflow = "";
  }
}

/**
 * 渲染股票详情内容
 */
function renderStockDetail(quote) {
  const s = quote;
  const isAShare = s.market === "SH" || s.market === "SZ";
  const currencySymbol = isAShare ? "¥" : "$";
  const marketLabel = isAShare ? (s.market === "SH" ? "沪市" : "深市") : "美股";
  const marketClass = s.market ? s.market.toLowerCase() : "us";

  const up = s.change >= 0;
  const changeClass = up ? "up" : "down";
  const arrow = up ? "▲" : "▼";

  const price = Number.isFinite(s.price) ? s.price.toFixed(2) : "--";
  const change = Number.isFinite(s.change) ? s.change.toFixed(2) : "--";
  const percent = Number.isFinite(s.percent) ? s.percent.toFixed(2) : "--";

  // 走势图 URL
  const chartUrl = getChartUrl(s.symbol, s.market);
  const chartLabel = isAShare ? "分时走势" : "日K线";

  // 收藏状态
  const starred = isInWatchlist(s.symbol);

  // 额外指标（A 股有更多数据）
  const open = Number.isFinite(s.open) ? s.open.toFixed(2) : "--";
  const high = Number.isFinite(s.high) ? s.high.toFixed(2) : "--";
  const low = Number.isFinite(s.low) ? s.low.toFixed(2) : "--";
  const prevClose = Number.isFinite(s.prevClose) ? s.prevClose.toFixed(2) : "--";
  const volume = s.volume ? (s.volume / 10000).toFixed(2) + "万" : "--";

  return `
    <div class="detail-header">
      <div class="detail-title">
        <span class="detail-symbol">${escapeHtml(s.symbol)}</span>
        <span class="detail-name">${escapeHtml(s.name || s.symbol)}</span>
      </div>
      <span class="detail-market-tag ${marketClass}">${marketLabel}</span>
    </div>
    
    <div class="detail-price-section">
      <div class="detail-price">${currencySymbol}${price}</div>
      <div class="detail-change ${changeClass}">
        <span>${arrow} ${change}</span>
        <span>${percent}%</span>
      </div>
    </div>
    
    <div class="detail-chart-section">
      <div class="detail-chart-title">${chartLabel}</div>
      <div class="detail-chart">
        <img src="${chartUrl}" alt="${chartLabel}" loading="lazy" onerror="this.parentElement.innerHTML='<div style=\\'text-align:center;padding:40px;color:#9ca3af;\\'>暂无走势图</div>'" />
      </div>
    </div>
    
    <div class="detail-metrics">
      <div class="metric-item">
        <div class="metric-label">开盘</div>
        <div class="metric-value">${currencySymbol}${open}</div>
      </div>
      <div class="metric-item">
        <div class="metric-label">昨收</div>
        <div class="metric-value">${currencySymbol}${prevClose}</div>
      </div>
      <div class="metric-item">
        <div class="metric-label">最高</div>
        <div class="metric-value">${currencySymbol}${high}</div>
      </div>
      <div class="metric-item">
        <div class="metric-label">最低</div>
        <div class="metric-value">${currencySymbol}${low}</div>
      </div>
      <div class="metric-item">
        <div class="metric-label">成交量</div>
        <div class="metric-value">${volume}</div>
      </div>
    </div>
    
    <div class="detail-actions">
      <button class="detail-star-btn ${starred ? "active" : ""}" data-symbol="${escapeHtml(s.symbol)}" data-name="${escapeHtml(s.name || s.symbol)}">
        ${starred ? "★ 已收藏" : "☆ 加入自选"}
      </button>
    </div>
  `;
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

    // 点击搜索建议项
    const suggestionItem = e.target.closest(".suggestion-item");
    if (suggestionItem) {
      const symbol = suggestionItem.dataset.symbol;
      if (symbol) {
        handleSuggestionClick(symbol);
      }
      return;
    }

    // 点击股票卡片打开详情（排除星标按钮）
    const stockCard = e.target.closest('[data-action="open-detail"]');
    if (stockCard && !e.target.closest(".star-btn")) {
      const symbol = stockCard.dataset.symbol;
      if (symbol) {
        openStockDetail(symbol);
      }
      return;
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
      hideSuggestions(); // 按回车时隐藏建议
      handleSearch(target.value);
    }

    // ESC 键隐藏建议
    if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  app.addEventListener("input", (e) => {
    if (e.target && e.target.classList.contains("search-input")) {
      const value = e.target.value;

      // 触发搜索建议（快速响应）
      if (suggestDebounceTimer) clearTimeout(suggestDebounceTimer);
      suggestDebounceTimer = setTimeout(async () => {
        if (value.trim()) {
          const suggestions = await fetchSearchSuggestions(value);
          renderSuggestions(suggestions);
        } else {
          hideSuggestions();
        }
      }, 200); // 200ms debounce for suggestions

      // 触发搜索（稍慢）
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        handleSearch(value);
      }, 400); // 400ms debounce for search
    }
  });

  // 点击页面其他地方时隐藏搜索建议
  document.addEventListener("click", (e) => {
    const searchSection = e.target.closest(".search-section");
    if (!searchSection) {
      hideSuggestions();
    }
  });

  // 详情弹窗事件
  const modal = document.querySelector("#stock-detail-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      // 关闭弹窗
      if (e.target.closest('[data-action="close-modal"]')) {
        closeStockDetail();
        return;
      }

      // 详情页内的收藏按钮
      const detailStarBtn = e.target.closest(".detail-star-btn");
      if (detailStarBtn) {
        const symbol = detailStarBtn.dataset.symbol;
        const name = detailStarBtn.dataset.name;
        if (!symbol) return;

        if (isInWatchlist(symbol)) {
          removeFromWatchlist(symbol);
        } else {
          const quote = state.quotesBySymbol[symbol] || state.searchResult;
          upsertWatchlist(symbol, quote || { symbol, name: name || symbol, price: 0, change: 0, percent: 0 });
        }

        // 更新弹窗内按钮状态
        const starred = isInWatchlist(symbol);
        detailStarBtn.className = `detail-star-btn ${starred ? "active" : ""}`;
        detailStarBtn.innerHTML = starred ? "★ 已收藏" : "☆ 加入自选";

        // 刷新列表
        refreshData({ silent: true });
      }
    });
  }

  eventsBound = true;
}

async function refreshData(options = {}) {
  // 缓存优先策略：如果有缓存数据，不显示加载状态，后台静默刷新
  const hasCachedData = state.watchlist.some((sym) => state.quotesBySymbol[sym]);
  const showLoading = !hasCachedData && !options.silent;

  if (showLoading) {
    state.ui = { loading: true, message: "加载中..." };
    renderLayout();
  }

  const updatedQuotes = { ...state.quotesBySymbol };

  try {
    const tasks = state.watchlist
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
            name: result.name || meta.name || sym, // 优先使用新浪返回的中文名称
            price: result.price,
            change: result.change,
            percent: result.changePercent,
            market: result.market, // 市场标识：SH/SZ/US
          };
        } else {
          // 如果有缓存数据但请求失败，保留缓存数据，只标记为过期
          if (updatedQuotes[sym] && !updatedQuotes[sym].error) {
            updatedQuotes[sym] = { ...updatedQuotes[sym], stale: true };
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
        }
      } else {
        const sym = entry.reason && entry.reason.sym ? entry.reason.sym : "未知";
        const meta = findStockMeta(sym);
        // 如果有缓存数据但请求失败，保留缓存数据
        if (!updatedQuotes[sym]) {
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
    }
  } finally {
    state.quotesBySymbol = updatedQuotes;
    state.ui = { loading: false, message: null };
    saveQuotesCache(); // 保存最新数据到缓存
    renderLayout();
  }
}

// ==================== 搜索建议功能 ====================

const API_BASE = import.meta.env.VITE_API_BASE;

/**
 * 获取搜索建议
 */
async function fetchSearchSuggestions(keyword) {
  if (!keyword || !keyword.trim()) return [];

  try {
    const url = `${API_BASE}/search?q=${encodeURIComponent(keyword)}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    return data.suggestions || [];
  } catch (err) {
    console.error("[search suggestions] 错误:", err);
    return [];
  }
}

/**
 * 渲染搜索建议列表
 */
function renderSuggestions(suggestions) {
  const container = document.querySelector("#search-suggestions");
  if (!container) return;

  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = "";
    container.classList.remove("active");
    return;
  }

  const html = suggestions.map(s => {
    const marketLabel = s.market === "US" ? "美股" : (s.market === "SH" ? "沪市" : "深市");
    const marketClass = s.market.toLowerCase();
    return `
      <div class="suggestion-item" data-symbol="${escapeHtml(s.symbol)}" data-market="${s.market}">
        <div class="suggestion-left">
          <span class="suggestion-symbol">${escapeHtml(s.symbol)}</span>
          <span class="suggestion-name">${escapeHtml(s.name)}</span>
        </div>
        <span class="suggestion-market ${marketClass}">${marketLabel}</span>
      </div>
    `;
  }).join("");

  container.innerHTML = html;
  container.classList.add("active");
}

/**
 * 隐藏搜索建议
 */
function hideSuggestions() {
  const container = document.querySelector("#search-suggestions");
  if (container) {
    container.classList.remove("active");
  }
}

/**
 * 处理搜索建议点击
 */
function handleSuggestionClick(symbol) {
  // 填充搜索框
  const input = document.querySelector(".search-input");
  if (input) {
    input.value = symbol;
  }

  // 隐藏建议列表
  hideSuggestions();

  // 执行搜索
  handleSearch(symbol);
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
    // 现在支持 A 股搜索（使用新浪 API）
    const meta = findStockMeta(value);
    const result = await fetchStock(meta.symbol);
    const matched = report.checks.find((c) => c.matchSymbol || c.matchName);

    if (result && !result.error) {
      const quote = {
        symbol: result.symbol || meta.symbol.toUpperCase(),
        name: result.name || meta.name, // 优先使用新浪返回的中文名称
        price: result.price,
        change: result.change,
        percent: result.changePercent,
        market: result.market,
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

// ==================== 智能自动更新 ====================

// 更新间隔配置（毫秒）
const REFRESH_INTERVAL = {
  TRADING: 30 * 1000,      // 开盘时间：30 秒
  NON_TRADING: 5 * 60 * 1000, // 非开盘时间：5 分钟
};

// 自动刷新状态
let autoRefreshTimer = null;
let currentInterval = null;

/**
 * 检测 A 股是否在交易时间
 * 交易时间：周一至周五 9:30-11:30, 13:00-15:00（北京时间）
 */
function isAShareTradingTime() {
  const now = new Date();
  const day = now.getDay(); // 0=周日, 1-5=周一至周五, 6=周六

  // 周末不交易
  if (day === 0 || day === 6) return false;

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeValue = hours * 60 + minutes; // 转换为分钟数便于比较

  // 上午：9:30 - 11:30 (570 - 690 分钟)
  const morningStart = 9 * 60 + 30;  // 9:30
  const morningEnd = 11 * 60 + 30;   // 11:30

  // 下午：13:00 - 15:00 (780 - 900 分钟)
  const afternoonStart = 13 * 60;    // 13:00
  const afternoonEnd = 15 * 60;      // 15:00

  return (timeValue >= morningStart && timeValue <= morningEnd) ||
    (timeValue >= afternoonStart && timeValue <= afternoonEnd);
}

/**
 * 检测美股是否在交易时间
 * 交易时间：周一至周五 21:30-04:00（北京时间，跨天）
 * 夏令时：21:30-04:00，冬令时：22:30-05:00
 * 这里简化处理，使用 21:30-05:00 覆盖两种情况
 */
function isUSStockTradingTime() {
  const now = new Date();
  const day = now.getDay();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeValue = hours * 60 + minutes;

  // 美股交易时间跨天，需要特殊处理
  // 晚间：21:30 - 23:59（周一至周五晚上）
  // 凌晨：00:00 - 05:00（周二至周六凌晨）

  const eveningStart = 21 * 60 + 30; // 21:30
  const morningEnd = 5 * 60;         // 05:00

  // 晚间交易（周一至周五 21:30 之后）
  if (day >= 1 && day <= 5 && timeValue >= eveningStart) {
    return true;
  }

  // 凌晨交易（周二至周六 05:00 之前）
  if (day >= 2 && day <= 6 && timeValue <= morningEnd) {
    return true;
  }

  // 周一凌晨不交易（周日晚上没有美股）
  return false;
}

/**
 * 检测是否有市场在交易中
 */
function isAnyMarketTrading() {
  return isAShareTradingTime() || isUSStockTradingTime();
}

/**
 * 获取当前应该使用的刷新间隔
 */
function getRefreshInterval() {
  return isAnyMarketTrading() ? REFRESH_INTERVAL.TRADING : REFRESH_INTERVAL.NON_TRADING;
}

/**
 * 获取交易状态描述
 */
function getTradingStatus() {
  const aShare = isAShareTradingTime();
  const usStock = isUSStockTradingTime();

  if (aShare && usStock) return "A 股 & 美股交易中";
  if (aShare) return "A 股交易中";
  if (usStock) return "美股交易中";
  return "休市";
}

/**
 * 启动自动刷新
 */
function startAutoRefresh() {
  // 清除旧的定时器
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }

  const interval = getRefreshInterval();
  currentInterval = interval;

  console.log(`[auto-refresh] ${getTradingStatus()} - 刷新间隔: ${interval / 1000} 秒`);

  autoRefreshTimer = setInterval(() => {
    // 检查间隔是否需要调整
    const newInterval = getRefreshInterval();
    if (newInterval !== currentInterval) {
      console.log(`[auto-refresh] 交易状态变化，重新调整刷新间隔`);
      startAutoRefresh(); // 重新启动以调整间隔
      return;
    }

    console.log(`[auto-refresh] 触发刷新 - ${getTradingStatus()}`);
    refreshData({ silent: true });
  }, interval);
}

/**
 * 停止自动刷新
 */
function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    currentInterval = null;
    console.log("[auto-refresh] 已停止");
  }
}

/**
 * 更新状态栏显示交易状态
 */
function updateTradingStatusDisplay() {
  const statusEl = document.querySelector("#trading-status");
  if (statusEl) {
    const status = getTradingStatus();
    const interval = getRefreshInterval() / 1000;
    statusEl.textContent = `${status} | 每 ${interval} 秒更新`;
    statusEl.className = isAnyMarketTrading() ? "trading-status active" : "trading-status";
  }
}

// ==================== 初始化 ====================

// 初始加载：先渲染缓存数据，再后台刷新
bindEventsOnce();
renderLayout(); // 立即显示缓存数据
refreshData({ silent: true }); // 后台静默刷新

// 启动智能自动刷新
startAutoRefresh();

// 立即显示交易状态
updateTradingStatusDisplay();

// 每分钟检查一次交易状态变化（用于状态显示）
setInterval(updateTradingStatusDisplay, 60 * 1000);

// 页面可见性变化时的处理
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // 页面隐藏时停止自动刷新，节省资源
    stopAutoRefresh();
    console.log("[auto-refresh] 页面隐藏，暂停刷新");
  } else {
    // 页面恢复时立即刷新并重启自动刷新
    refreshData({ silent: true });
    startAutoRefresh();
    console.log("[auto-refresh] 页面恢复，重启刷新");
  }
});
