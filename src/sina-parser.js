/**
 * 新浪股票 API 数据解析模块
 * 
 * 支持市场：
 * - A 股：http://hq.sinajs.cn/list=sh600519 或 sz000001
 * - 美股：http://hq.sinajs.cn/list=gb_aapl
 * 
 * 特点：
 * - 处理 GBK 编码转换，防止中文乱码
 * - HTTP 请求头必须包含 Referer: https://finance.sina.com.cn
 * - 解析返回的字符串为结构化对象
 */

// GBK 解码器（浏览器环境使用 TextDecoder）
function decodeGBK(arrayBuffer) {
    try {
        const decoder = new TextDecoder('gbk');
        return decoder.decode(arrayBuffer);
    } catch (err) {
        // 部分浏览器可能不支持 GBK，回退到 gb18030
        try {
            const decoder = new TextDecoder('gb18030');
            return decoder.decode(arrayBuffer);
        } catch (fallbackErr) {
            console.error('[sina-parser] GBK 解码失败:', fallbackErr);
            throw new Error('GBK 编码转换失败，浏览器可能不支持该编码');
        }
    }
}

/**
 * 判断股票代码所属市场
 * 
 * @param {string} symbol - 股票代码
 * @returns {'A_SH' | 'A_SZ' | 'US' | null} - 市场类型
 */
function detectMarket(symbol) {
    const s = (symbol || '').trim().toUpperCase();

    // 已带前缀的情况
    if (s.startsWith('SH') && /^SH\d{6}$/.test(s)) return 'A_SH';
    if (s.startsWith('SZ') && /^SZ\d{6}$/.test(s)) return 'A_SZ';
    if (s.startsWith('GB_')) return 'US';

    // 纯 6 位数字判断（A 股）
    if (/^\d{6}$/.test(s)) {
        // 6/9 开头为沪市，0/2/3 开头为深市
        const firstDigit = s[0];
        if (['6', '9'].includes(firstDigit)) return 'A_SH';
        if (['0', '2', '3'].includes(firstDigit)) return 'A_SZ';
        // 无法判断默认沪市
        return 'A_SH';
    }

    // 后缀格式：600519.SS 或 000001.SZ
    if (/\.SS$/.test(s) || /\.SH$/.test(s)) return 'A_SH';
    if (/\.SZ$/.test(s)) return 'A_SZ';

    // 其他情况视为美股
    return 'US';
}

/**
 * 将股票代码转换为新浪 API 格式
 * 
 * @param {string} symbol - 股票代码
 * @returns {string} - 新浪 API 格式的代码
 * 
 * @example
 * formatSinaSymbol('AAPL')    -> 'gb_aapl'
 * formatSinaSymbol('600519')  -> 'sh600519'
 * formatSinaSymbol('000001')  -> 'sz000001'
 * formatSinaSymbol('SH600519') -> 'sh600519'
 */
function formatSinaSymbol(symbol) {
    const s = (symbol || '').trim().toUpperCase();
    const market = detectMarket(s);

    // 提取纯代码部分
    let code = s;

    if (market === 'A_SH') {
        // 移除前缀和后缀
        code = s.replace(/^SH/, '').replace(/\.SS$/, '').replace(/\.SH$/, '');
        return `sh${code}`;
    }

    if (market === 'A_SZ') {
        code = s.replace(/^SZ/, '').replace(/\.SZ$/, '');
        return `sz${code}`;
    }

    // 美股
    if (s.startsWith('GB_')) {
        return s.toLowerCase();
    }
    return `gb_${s.toLowerCase()}`;
}

/**
 * 判断是否为 A 股代码
 * 
 * @param {string} symbol - 股票代码
 * @returns {boolean}
 */
function isAShareSymbol(symbol) {
    const market = detectMarket(symbol);
    return market === 'A_SH' || market === 'A_SZ';
}

/**
 * 解析新浪 A 股 API 返回的字符串
 * 
 * A 股示例（21 个字段）：
 * var hq_str_sh600519="贵州茅台,1741.00,1744.00,1755.98,1765.00,1736.00,1755.98,1756.00,12345678,21234567890,100,1755.98,200,1755.97,300,1755.96,100,1756.00,200,1756.01,300,1756.02,2024-01-02,15:00:00,00";
 * 
 * 字段说明：
 * 0: 股票名称
 * 1: 今日开盘价
 * 2: 昨日收盘价
 * 3: 当前价格
 * 4: 今日最高价
 * 5: 今日最低价
 * 6: 买一价
 * 7: 卖一价
 * 8: 成交量（股）
 * 9: 成交额（元）
 * 10-19: 买卖五档
 * 30: 日期
 * 31: 时间
 */
function parseAShareResponse(dataString, sinaSymbol) {
    const fields = dataString.split(',');

    if (fields.length < 10) {
        console.error('[sina-parser] A 股数据字段不足:', fields.length);
        return null;
    }

    const stockName = fields[0] || '';
    const openPrice = parseFloat(fields[1]);
    const prevClose = parseFloat(fields[2]);
    const currentPrice = parseFloat(fields[3]);
    const highPrice = parseFloat(fields[4]);
    const lowPrice = parseFloat(fields[5]);
    const volume = parseInt(fields[8], 10);
    const amount = parseFloat(fields[9]);
    const tradeDate = fields[30] || '';
    const tradeTime = fields[31] || '';

    if (isNaN(currentPrice) || currentPrice === 0) {
        // 可能是停牌状态，使用昨收盘价
        if (isNaN(prevClose) || prevClose === 0) {
            console.error('[sina-parser] A 股价格解析失败');
            return null;
        }
    }

    const price = currentPrice || prevClose;
    const change = isNaN(prevClose) ? 0 : (price - prevClose);
    const changePercent = isNaN(prevClose) || prevClose === 0
        ? 0
        : ((change / prevClose) * 100);

    // 提取股票代码（去掉 sh/sz 前缀）
    const symbol = sinaSymbol.replace(/^(sh|sz)/i, '').toUpperCase();

    return {
        symbol: symbol,
        name: stockName,
        price: price,
        change: parseFloat(change.toFixed(2)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        tradeTime: `${tradeDate} ${tradeTime}`.trim(),

        // A 股扩展数据
        openPrice: openPrice || null,
        highPrice: highPrice || null,
        lowPrice: lowPrice || null,
        prevClose: prevClose || null,
        volume: volume || null,
        amount: amount || null,

        // 元数据
        market: sinaSymbol.startsWith('sh') ? 'SH' : 'SZ',
        source: 'sina',
        fetchedAt: new Date().toISOString(),
        _rawSymbol: sinaSymbol,
    };
}

/**
 * 解析新浪美股 API 返回的字符串
 * 
 * 美股示例：
 * var hq_str_gb_aapl="苹果,242.4500,0.80,2025-12-31 15:59:00,-1.90,-0.78,242.0400,243.3600,249.9700,164.0800,3833800367776,169.98,14.27,3.826B,AAPL,Dec 31 03:59PM EST,242.3696,255.5900,160.2000,APPL.OQ,0";
 * 
 * 字段说明：
 * 0: 股票名称（中文）
 * 1: 当前价格
 * 2: 涨跌幅（%）
 * 3: 交易时间
 * 4: 涨跌额
 * 5: 涨跌幅重复
 * 6: 今日开盘价
 * 7: 今日最高价
 * 8: 52周最高
 * 9: 52周最低
 * 10: 市值
 * 11: 市盈率
 * 12: 每股收益
 * 13: 成交量
 * 14: 股票代码
 * 15: 美东时间
 */
function parseUSStockResponse(dataString, sinaSymbol) {
    const fields = dataString.split(',');

    if (fields.length < 5) {
        console.error('[sina-parser] 美股数据字段不足:', fields.length);
        return null;
    }

    const stockName = fields[0] || '';
    const currentPrice = parseFloat(fields[1]);
    const changePercent = parseFloat(fields[2]);
    const tradeTime = fields[3] || '';
    const priceChange = parseFloat(fields[4]);

    const openPrice = parseFloat(fields[6]) || null;
    const highPrice = parseFloat(fields[7]) || null;
    const week52High = parseFloat(fields[8]) || null;
    const week52Low = parseFloat(fields[9]) || null;
    const marketCap = fields[10] || null;
    const pe = parseFloat(fields[11]) || null;
    const eps = parseFloat(fields[12]) || null;
    const volume = fields[13] || null;
    const symbol = fields[14] || sinaSymbol.replace('gb_', '').toUpperCase();
    const usTime = fields[15] || '';

    if (isNaN(currentPrice)) {
        console.error('[sina-parser] 美股价格解析失败:', fields[1]);
        return null;
    }

    return {
        symbol: symbol,
        name: stockName,
        price: currentPrice,
        change: isNaN(priceChange) ? 0 : priceChange,
        changePercent: isNaN(changePercent) ? 0 : changePercent,
        tradeTime: tradeTime,
        usTime: usTime,

        // 美股扩展数据
        openPrice: openPrice,
        highPrice: highPrice,
        week52High: week52High,
        week52Low: week52Low,
        marketCap: marketCap,
        pe: pe,
        eps: eps,
        volume: volume,

        // 元数据
        market: 'US',
        source: 'sina',
        fetchedAt: new Date().toISOString(),
        _rawSymbol: sinaSymbol,
    };
}

/**
 * 解析新浪 API 返回的字符串（自动识别 A 股/美股）
 * 
 * @param {string} rawResponse - 新浪 API 返回的原始字符串
 * @returns {Object|null} - 解析后的股票数据对象
 */
function parseSinaResponse(rawResponse) {
    if (!rawResponse || typeof rawResponse !== 'string') {
        console.error('[sina-parser] 响应为空或非字符串类型');
        return null;
    }

    // 匹配 var hq_str_xxx="data"; 格式
    const match = rawResponse.match(/var\s+hq_str_([^=]+)="([^"]*)"/);
    if (!match) {
        console.error('[sina-parser] 无法匹配响应格式:', rawResponse.slice(0, 100));
        return null;
    }

    const sinaSymbol = match[1]; // 如 gb_aapl 或 sh600519
    const dataString = match[2];

    if (!dataString || dataString.trim() === '') {
        console.warn('[sina-parser] 股票数据为空，可能代码无效:', sinaSymbol);
        return null;
    }

    // 根据前缀判断市场类型
    if (sinaSymbol.startsWith('sh') || sinaSymbol.startsWith('sz')) {
        return parseAShareResponse(dataString, sinaSymbol);
    } else if (sinaSymbol.startsWith('gb_')) {
        return parseUSStockResponse(dataString, sinaSymbol);
    } else {
        console.warn('[sina-parser] 未知市场类型:', sinaSymbol);
        return null;
    }
}

/**
 * 从新浪 API 获取股票行情数据（支持 A 股和美股）
 * 
 * @param {string} symbol - 股票代码
 * @returns {Promise<Object>} - 解析后的股票数据
 * 
 * @example
 * // 美股
 * const apple = await fetchSinaStock('AAPL');
 * console.log(apple.name);  // "苹果"
 * 
 * // A 股
 * const moutai = await fetchSinaStock('600519');
 * console.log(moutai.name);  // "贵州茅台"
 */
export async function fetchSinaStock(symbol) {
    const sinaSymbol = formatSinaSymbol(symbol);
    const url = `http://hq.sinajs.cn/list=${sinaSymbol}`;

    console.log(`[sina-parser] 请求: ${url}`);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Referer': 'https://finance.sina.com.cn',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // 获取原始二进制数据并转换 GBK 编码
        const arrayBuffer = await response.arrayBuffer();
        const decodedText = decodeGBK(arrayBuffer);

        console.log(`[sina-parser] 原始响应: ${decodedText.slice(0, 100)}...`);

        const parsed = parseSinaResponse(decodedText);

        if (!parsed) {
            return {
                symbol: symbol.toUpperCase(),
                error: '解析失败或股票代码无效'
            };
        }

        return parsed;

    } catch (err) {
        console.error(`[sina-parser] 请求失败:`, err);
        return {
            symbol: symbol.toUpperCase(),
            error: err.message || '网络请求失败'
        };
    }
}

/**
 * 批量获取多只股票行情（支持混合 A 股和美股）
 * 
 * @param {string[]} symbols - 股票代码数组
 * @returns {Promise<Object[]>} - 解析后的股票数据数组
 * 
 * @example
 * const data = await fetchSinaStockBatch(['AAPL', '600519', '000001']);
 */
export async function fetchSinaStockBatch(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
        return [];
    }

    // 构建批量请求 URL（新浪支持逗号分隔多个代码）
    const sinaSymbols = symbols.map(formatSinaSymbol).join(',');
    const url = `http://hq.sinajs.cn/list=${sinaSymbols}`;

    console.log(`[sina-parser] 批量请求: ${url}`);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Referer': 'https://finance.sina.com.cn',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const decodedText = decodeGBK(arrayBuffer);

        // 批量响应是多行，每行一个股票
        const lines = decodedText.split('\n').filter(line => line.trim());
        const results = [];

        for (const line of lines) {
            const parsed = parseSinaResponse(line);
            if (parsed) {
                results.push(parsed);
            }
        }

        return results;

    } catch (err) {
        console.error(`[sina-parser] 批量请求失败:`, err);
        return symbols.map(s => ({
            symbol: s.toUpperCase(),
            error: err.message || '网络请求失败'
        }));
    }
}

// 导出工具函数
export {
    formatSinaSymbol,
    parseSinaResponse,
    decodeGBK,
    detectMarket,
    isAShareSymbol
};
