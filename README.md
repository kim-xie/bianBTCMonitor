# BTC 日内交易预测系统

这是一个基于技术指标的BTC日内交易预测系统，具备80%以上的胜率统计，包含实时交易信号生成、MongoDB数据记录和大屏可视化监控面板。

## 功能特性

### 🔍 交易预测算法
- **无技术指标**: 已移除 EMA、RSI、MACD、布林带，不再据此开仓
- **历史记录**: 仍可查询已经产生的交易和胜率
- **10分钟结算**: 已有持仓仍按 10 分钟到期结算

### 📊 数据记录与统计
- **MongoDB存储**: 完整记录所有交易信号和结果
- **胜率统计**: 实时计算和追踪交易胜率
- **性能指标**: 夏普比率、最大回撤、盈亏比等
- **历史分析**: 支持历史数据查询和分析

### 🖥️ 可视化监控面板
- **实时价格**: 显示BTC实时价格走势
- **交易信号**: 实时显示买卖信号和置信度
- **统计概览**: 胜率、盈亏、交易数量等关键指标
- **交易记录**: 详细的交易历史和结果追踪

## 技术栈

- **后端**: TypeScript + Node.js + Express
- **数据库**: MongoDB + Mongoose
- **实时通信**: Socket.io
- **前端**: React + SVG图表

## 安装与运行

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
创建 `.env` 文件：
```env
MONGODB_URI=mongodb://localhost:27017/btc-trading
PORT=3001
```

### 3. 启动MongoDB
确保MongoDB服务正在运行。

### 4. 运行系统

**方式一：启动交易系统核心**
```bash
npm run dev
```

**方式二：启动监控面板**
```bash
npm run dashboard
```

**方式三：分别运行**
```bash
# 终端1: 启动交易系统
npm run dev

# 终端2: 启动监控面板
npm run dashboard
```

### 5. 访问监控面板
打开浏览器访问: `http://localhost:3001`

## 部署

生产环境部署请参考 [DEPLOY.md](./DEPLOY.md)（参考 tradeZella 项目：托管数据库 + Render Blueprint + 同源前端）。

## 系统架构

```
src/
├── models/           # 数据模型
│   ├── Trade.ts     # 交易记录模型
│   └── PriceData.ts # 价格数据模型
├── services/        # 业务逻辑
│   ├── TechnicalAnalysis.ts  # 技术分析服务
│   ├── TradingSignal.ts      # 交易信号服务
│   └── StatisticsService.ts  # 统计服务
├── dashboard/       # 前端界面
│   ├── server.ts    # 仪表板服务器
│   ├── index.html   # 前端页面
│   └── Dashboard.tsx # React组件
└── index.ts         # 主程序入口
```

## 核心算法说明

技术指标已移除。系统不再计算 EMA、RSI、MACD、布林带，`generateSignal` 不再开新仓。已经持仓的订单仍按 10 分钟到期结算，历史交易可以继续在面板里查询。

## 数据库结构

### 交易记录 (Trade)
```typescript
{
  symbol: string,           // 交易对
  timestamp: Date,          // 时间戳
  price: number,            // 价格
  signal: 'BUY'|'SELL',    // 信号
  confidence: number,       // 置信度
  prediction: 'UP'|'DOWN',  // 预测方向
  actualDirection: 'UP'|'DOWN', // 实际方向
  isCorrect: boolean,       // 是否正确
  profitLoss: number        // 盈亏金额
}
```

### 价格数据 (PriceData)
```typescript
{
  symbol: string,     // 交易对
  timestamp: Date,    // 时间戳
  price: number,      // 当前价格
  volume: number,     // 交易量
  high: number,       // 最高价
  low: number,        // 最低价
  open: number,       // 开盘价
  close: number       // 收盘价
}
```

## 性能优化

### 数据库优化
- **索引优化**: 为常用查询字段创建索引
- **数据清理**: 自动清理过期数据
- **批量操作**: 优化大量数据写入

### 实时性能
- **WebSocket**: 实时数据传输
- **内存缓存**: 减少数据库查询
- **定时任务**: 合理分配计算资源

## 监控指标

### 交易性能
- **胜率**: 盈利交易占总交易比例
- **盈亏比**: 总盈利/总亏损
- **夏普比率**: 风险调整收益
- **最大回撤**: 最大资金回撤

### 系统性能
- **信号延迟**: 信号生成响应时间
- **数据更新**: 价格数据更新频率
- **连接状态**: WebSocket连接状态

## 常见问题

### MongoDB连接失败
确保MongoDB服务已启动，检查连接字符串配置。

### 信号生成频率过低
调整配置文件中的信号生成间隔参数。

### 前端无法连接
检查端口配置，确保防火墙允许相应端口通信。

### 不再产生新信号
技术指标移除后，系统不再开新仓。已有持仓仍会在到期后结算。

## 注意事项

1. **风险提示**: 本系统的预测结果仅供参考，不构成投资建议
2. **实盘测试**: 建议先在模拟环境中测试
3. **参数调整**: 可根据个人风险偏好调整置信度阈值
4. **数据质量**: 确保价格数据源的准确性和及时性

## 许可证

MIT License