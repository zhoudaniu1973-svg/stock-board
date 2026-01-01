# 📈 Stock Board · 股票数据可视化看板

一个支持 **A 股 + 美股** 实时行情查询的轻量级 Web 看板，具备模糊搜索、自选股管理和智能刷新功能。

![股票看板截图](https://img.shields.io/badge/Status-Active-brightgreen)

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 **模糊搜索** | 输入"茅台"显示 600519，输入"nvidia"显示 NVDA |
| 🇨🇳🇺🇸 **双市场支持** | A 股（沪/深）和美股实时行情 |
| 💰 **智能货币符号** | A 股显示 ¥，美股显示 $ |
| ⭐ **自选股收藏** | 本地持久化，支持 A 股和美股混合自选 |
| ⏱️ **智能刷新** | 开盘时间 30 秒更新，休市时间 5 分钟更新 |
| 📊 **交易状态指示** | 实时显示 A 股/美股交易状态 |

## 🛠️ 技术栈

### 前端
- **Vite** + 原生 JavaScript
- localStorage 自选股持久化
- 响应式设计

### 后端
- **Node.js** + **Express**
- 代理新浪股票 API（行情 + 搜索建议）
- **iconv-lite** 处理 GBK 编码
- 缓存 + 限流 + 请求去重

### Android
- **Capacitor** 封装 WebView
- 支持打包为 APK

## 📁 项目结构

```
stock-board/
├── server.js              # 后端 API 服务
├── index.html             # 前端入口
├── src/
│   ├── main.js            # 主逻辑 + 自动刷新
│   ├── stock-card.js      # 股票数据获取
│   ├── sina-parser.js     # 新浪 API 解析（前端备用）
│   └── style.css          # 样式
├── android/               # Android 项目（Capacitor）
├── .env                   # 环境变量
└── package.json
```

## 🚀 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
FMP_API_KEY=your_api_key_here  # 可选，FMP 备用数据源
```

创建 `.env.development` 文件：

```env
VITE_API_BASE=http://localhost:3000
```

### 3. 启动后端

```bash
node server.js
```

### 4. 启动前端

```bash
npm run dev
```

访问 http://localhost:5173/

## 📡 API 接口

### 股票行情

| 接口 | 说明 | 示例 |
|------|------|------|
| `GET /sina/:symbol` | 单只股票行情 | `/sina/AAPL` 或 `/sina/600519` |
| `GET /sina-batch?symbols=` | 批量查询 | `/sina-batch?symbols=AAPL,600519` |
| `GET /search?q=` | 模糊搜索 | `/search?q=茅台` |
| `GET /stock/:symbol` | FMP 行情（备用） | `/stock/AAPL` |

### 响应示例

```json
{
  "symbol": "600519",
  "name": "贵州茅台",
  "price": 1377.18,
  "change": -12.54,
  "percent": -0.9,
  "market": "SH",
  "source": "sina"
}
```

## 📱 Android 打包

```bash
# 构建前端
npm run build

# 同步到 Android
npx cap sync android

# 打开 Android Studio
npx cap open android

# 或直接构建 APK
cd android && ./gradlew assembleDebug
```

## 🧠 开发说明

本项目由本人主导设计与实现，借助 **AI（Gemini，antigravity,claude）** 完成代码编写与问题排查。

- **我负责**：功能规划、架构设计、需求判断
- **AI 负责**：代码生成、调试排错、工具链配置

所有代码均在本地理解、运行、调试并最终上线。

## 📝 数据源说明

- **新浪财经 API**（主要）：免费、实时、支持 A 股 + 美股
- **Financial Modeling Prep**（备用）：需 API Key

> ⚠️ 新浪 API 为非官方接口，可能随时变动。生产环境建议使用付费数据源。

## 🔗 相关链接

- 仓库：https://github.com/zhoudaniu1973-svg/stock-board

## 📄 License

MIT

---

*最后更新：2026-01-01*
