# 部署指南（参考 tradeZella 的部署方式）

本项目部署方式与 [tradeZella](E:/codes/tradeZella) 保持一致：

- **后端/前端同源部署**：Express 同时提供 API、Socket.io 和静态页面（`index.html` + `public/*.html`）
- **托管数据库**：tradeZella 使用 Neon（托管 PostgreSQL），本项目使用 **MongoDB Atlas**（托管 MongoDB）
- **环境变量注入**：本地用 `.env`，生产用平台（Render）注入的 `process.env`
- **前端使用相对路径**：生产环境前端请求 `/api/...`，自动使用当前域名，无需改代码

---

## 一、前置准备

1. 一个 [MongoDB Atlas](https://www.mongodb.com/atlas) 集群，创建数据库用户并获取连接串
   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/btc-trading?retryWrites=true&w=majority
   ```
   > 注意：在 Atlas 的 **Network Access** 中允许 `0.0.0.0/0`（任意 IP），否则 Render 服务器无法连接。
2. 一个 [Render](https://render.com) 账号
3. （可选）飞书机器人 Webhook 地址，用于接收交易信号通知

## 二、部署到 Render（Blueprint 一键部署）

本仓库已包含 `render.yaml`，可以直接用 Blueprint 部署：

1. 将代码推送到 GitHub / GitLab 仓库
2. Render 控制台 → **New** → **Blueprint**
3. 选择仓库，Render 会自动读取 `render.yaml`
4. 填写环境变量：
   - `MONGODB_URI`：填入 MongoDB Atlas 连接串（必填）
   - `JWT_SECRET`：可让 Render 自动生成
   - `FEISHU_WEBHOOK_URL`：飞书机器人地址（可选）
   - `PROXY_HOST` / `PROXY_PORT` 等：币安代理（可选，服务器可直连则留空）
5. 点击 **Apply**，等待构建完成

部署完成后 Render 会分配一个公网域名（如 `https://btc-trading-dashboard.onrender.com`），访问即可看到监控面板。

## 三、构建与启动命令

`package.json` 中已配置好生产命令：

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript 并复制前端静态资源到 `dist/` |
| `npm start` | 启动生产服务（`dist/dashboard/server.js`，含 UI + API + 交易循环） |
| `npm run start:core` | 仅启动无界面的交易核心（`dist/index.js`） |
| `npm run dev` | 本地开发：交易核心 |
| `npm run dashboard` | 本地开发：监控面板 |

`npm run build` 会执行：
```bash
tsc && node scripts/copy-assets.js
```
其中 `scripts/copy-assets.js` 负责把 `src/dashboard/index.html` 和 `src/dashboard/public/` 复制到 `dist/dashboard/`，保证生产环境能正常提供前端页面。

## 四、本地验证生产构建

```bash
npm install
npm run build
npm start
# 访问 http://localhost:3001
```

## 五、注意事项

### 1. Render 免费计划会休眠
免费 Web Service 在 15 分钟无请求后会休眠，交易信号循环也会停止。若要 24 小时运行交易系统，请使用 **Starter** 及以上计划（`render.yaml` 中已配置 `plan: starter`）。

### 2. 币安 API 区域限制
`binance.com` 会限制部分地区的访问。`render.yaml` 中已将区域设为 `singapore`，对币安 API 更友好。若仍无法连接，请配置代理环境变量。

### 3. 环境变量安全
`.env` 已被 `.gitignore` 忽略。生产环境的密钥（MongoDB 连接串、JWT_SECRET、飞书 Webhook）请通过 Render 控制台配置，不要提交到代码仓库。

### 4. 数据库选择
- 本地开发：`mongodb://localhost:27017/btc-trading`
- 生产：MongoDB Atlas 连接串（等价于 tradeZella 使用的 Neon 托管数据库）

### 5. 前端同源请求
前端代码已从硬编码 `http://localhost:3001` 改为相对路径 `/api/...`，`socket.io` 也改为同源连接。因此生产环境无需再修改前端地址。
