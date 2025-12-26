📈 Stock Board · 股票数据可视化看板

一个用于快速查询股票价格、涨跌幅，并支持本地收藏的轻量级 Web 看板。
项目重点不在“功能复杂”，而在于完整走通一条现代 Web 应用的开发与部署链路。

✨ 功能概览

🔍 股票代码搜索（如 AAPL）

💲 实时价格与涨跌幅展示

⭐ 自选股收藏（浏览器本地持久化）

🌐 前后端分离部署

⚡ 页面秒级加载，零登录、零配置

🧱 技术结构
前端

Vite + 原生 JavaScript

纯前端渲染（Static Site）

localStorage 做自选股持久化

通过环境变量配置后端 API 地址

后端

Node.js + Express

股票数据代理接口（避免前端直连第三方 API）

提供稳定、可部署的 REST API

部署为 Render Web Service

🗂️ 项目结构
.
├─ server.js              # 后端 API 服务
├─ index.html             # 前端入口
├─ src/
│  ├─ main.js             # 页面逻辑
│  ├─ stock-card.js       # 股票卡片组件
│  └─ style.css           # 样式
├─ package.json
└─ README.md

🚀 部署架构
浏览器（前端 Static Site）
        ↓
Render Static Site
        ↓
HTTP API
        ↓
Render Web Service（Node.js）


前端：Render Static Site

后端：Render Web Service

前后端通过 VITE_API_BASE 解耦连接

全流程自动化部署（GitHub → Render）

🧠 开发方式说明（重点）

本项目由本人主导设计与实现，借助 AI（ChatGPT / Codex）完成代码编写与问题排查。

使用方式不是“让 AI 替我写项目”，而是：

我负责：

功能边界判断

架构取舍（前后端是否拆分、是否需要数据库）

部署路径选择

AI 负责：

代码生成与修改

报错定位

Render / GitHub / Vite 等工具链细节补全

所有代码均在本地理解、运行、调试并最终上线。

📌 关于数据持久化

当前版本使用 浏览器本地持久化（localStorage）

特点：

每个浏览器 / 设备独立

无账号、无登录、零成本

这是一个刻意选择：

作为工具型 / 展示型项目，足够且合理

未引入数据库与用户系统，避免过度工程化

🧭 项目定位

✅ 技术展示型项目

✅ AI 协作开发实践样例

❌ 非商业产品

❌ 非重后端系统

目标是：
用最小复杂度，跑通完整现代 Web 开发闭环。

🔗 在线地址

前端：👉 https://stock-board-xxxx.com/

后端 API：👉 https://stock-board-api.onrender.com/

📝 后续可扩展方向（未实现）

服务器端收藏（用户同步）

历史价格 / 简单图表

多市场支持（美股 / 港股）

以上均为“可以做，但刻意没做”。

📄 License

MIT

