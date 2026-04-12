# Claude Code - BTC交易监控系统开发规范

## 🎯 项目概览

**项目名称**: BTC交易监控系统  
**技术栈**: React + TypeScript + Node.js + Express + MongoDB  
**目标**: 专业级比特币交易信号生成与监控系统  
**状态**: 生产就绪 ✅

## 📋 开发规范

### **1. 代码质量标准**

#### **TypeScript规范**
```typescript
// ✅ 推荐: 明确的类型定义
interface ITrade {
  symbol: string;
  timestamp: Date;
  price: number;
  signal: 'BUY' | 'SELL';
  confidence: number;
  investmentAmount: number; // 固定金额
  reasoning?: string[];     // 入场原因
  isCorrect?: boolean;
  profitLoss?: number;
}

// ❌ 避免: 隐式any类型
const trade = {} as any; // 应该明确类型
```

#### **React最佳实践**
```jsx
// ✅ 推荐: 函数组件 + Hooks
const Dashboard = () => {
  const [currentBalance, setCurrentBalance] = useState(1000); // 明确初始值
  const [balanceHistory, setBalanceHistory] = useState<BalancePoint[]>([]);

  return (
    <div className="dashboard">
      {/* 清晰的JSX结构 */}
    </div>
  );
};

// ✅ 推荐: 自定义Hook分离逻辑
const useBalanceHistory = () => {
  // 资金历史管理逻辑
};
```

#### **Node.js/Express规范**
```javascript
// ✅ 推荐: 错误优先的异步处理
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await statisticsService.calculateWinRate();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});
```

### **2. 文件组织原则**

```
src/
├── models/           # 数据模型 (Mongoose Schema)
│   ├── Trade.ts
│   ├── User.ts
│   └── ...
├── services/         # 业务服务层
│   ├── TradingSignal.ts
│   ├── TechnicalAnalysis.ts
│   └── StatisticsService.ts
├── controllers/      # 控制器 (路由处理)
│   ├── authController.ts
│   └── ...
├── routes/           # API路由定义
│   └── ...
├── middleware/       # 中间件
│   ├── auth.ts
│   └── subscriptionGuard.ts
├── dashboard/        # 仪表板服务器
│   └── server.ts     # 主服务器文件
└── types/            # TypeScript类型定义
    └── express.d.ts
```

### **3. 命名约定**

#### **变量命名**
```typescript
// ✅ 推荐: 清晰、描述性强的命名
const currentBalance = 1000;           // 当前资金
const investmentAmount = 10;           // 每次开仓金额
const usedFiveMinuteKlines = new Set(); // K线使用记录

// ❌ 避免: 模糊或缩写
let a = 1000;                           // 应该用有意义的名字
let b = new Set();                      // 应该说明用途
```

#### **函数命名**
```typescript
// ✅ 推荐: 动词开头，明确功能
async generateTradingSignal(): Promise<TradingSignal | null>
private markKlineAsUsed(closeTime: number): boolean
public cleanupExpiredKlines(): void

// ❌ 避免: 无意义的命名
function doStuff() {}
function processData() {}
```

### **4. 错误处理规范**

```typescript
// ✅ 推荐: 完整的错误处理
class TradingSignalService {
  async generateSignal(symbol: string, klines: any[]): Promise<TradingSignal | null> {
    try {
      // 业务逻辑
      if (!this.validateKlines(klines)) {
        throw new Error('无效的K线数据');
      }

      // ... 其他逻辑

    } catch (error) {
      console.error(`生成交易信号时出错: ${error.message}`);
      // 记录详细日志
      logger.error('Signal generation failed', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }
}
```

### **5. 日志记录标准**

```typescript
// ✅ 推荐: 结构化日志记录
console.log('📊 K线分析: closeTime=%d, closePrice=%f', klineCloseTime, lastFiveKline.close);

// 错误级别分类
console.log('✅ 成功操作');      // 成功信息
console.warn('⚠️  警告信息');    // 潜在问题
console.error('❌ 错误信息');   // 严重错误
```

## 注意事项
不必每个文件都要生成对应的测试文件，只需要在需要时添加即可。
非必要不新增fixed文件，在原来的文件操作即可。
要用中文交互
项目级的操作不要记录到根配置文件中，而是在当前项目目录下进行。

## 🚀 工作流程

### **1. 开发流程**

```bash
# 1. 创建新特性分支
git checkout -b feature/new-search-function

# 2. 开发新功能
# 编写代码，遵循上述规范

# 3. 运行测试和验证
npm test
node -c src/dashboard/server.ts

# 4. 提交更改
git add .
git commit -m "feat: 添加按入场原因的模糊查询功能"

# 5. 推送到远程
git push origin feature/new-search-function
```

### **2. 代码审查要点**

- ✅ 是否有适当的错误处理？
- ✅ 是否符合TypeScript类型安全要求？
- ✅ 是否有必要的日志记录？
- ✅ 是否遵循了命名约定？
- ✅ 是否有性能考虑？
- ✅ 是否添加了适当的注释？

### **3. 部署检查清单**

```markdown
- [ ] 所有测试通过 (npm test)
- [ ] 代码编译无错误 (tsc --noEmit)
- [ ] 语法检查通过 (node -c src/dashboard/server.ts)
- [ ] 核心功能手动测试完成
- [ ] 性能基准测试通过
- [ ] 安全扫描无高危漏洞
- [ ] 文档更新完成
```

## 📊 性能指标

### **响应时间目标**
```
API端点: < 200ms
WebSocket: < 100ms
数据库查询: < 50ms
前端渲染: < 100ms
```

### **并发能力**
```
最大用户数: 100+
同时持仓: 5笔/用户
信号生成频率: 每分钟
数据更新频率: 实时
```

## 🛡️ 安全规范

### **认证授权**
```typescript
// JWT认证中间件
import { AuthRequest } from '../middleware/auth';

app.get('/api/stats', authenticateToken, async (req: AuthRequest, res) => {
  // req.user 包含认证信息
});
```

### **输入验证**
```typescript
// 参数验证示例
function validateSearchFilters(filters: SearchFilters) {
  if (!filters.reasoningKeyword || filters.reasoningKeyword.length > 100) {
    throw new Error('搜索关键词长度超出限制');
  }
  // ... 其他验证
}
```

### **数据安全**
```
敏感信息: 不记录在日志中
密码存储: bcrypt加密
会话管理: JWT短期token
CSRF防护: 已集成
XSS防护: React自动转义
```

## 📈 监控与告警

### **关键监控指标**
```
- 系统可用性: > 99.9%
- API错误率: < 0.1%
- 平均响应时间: < 200ms
- 内存使用率: < 80%
- 磁盘空间: > 10GB可用
```

### **告警阈值**
```
CPU使用率 > 80%: 立即告警
内存使用率 > 85%: 立即告警
错误率 > 1%: 严重告警
响应时间 > 1s: 性能告警
```

## 🔧 故障排除指南

### **常见问题解决方案**

**问题1**: 5分钟K线重复生成信号
```bash
# 检查K线使用记录
grep -r "usedFiveMinuteKlines" src/services/
# 验证清理机制
grep -r "cleanupExpiredKlines" src/
```

**问题2**: 资金走势显示异常
```bash
# 检查资金计算逻辑
grep -r "calculateBalanceHistory" src/dashboard/
# 验证WebSocket连接
grep -r "balanceUpdate" src/dashboard/server.ts
```

**问题3**: 搜索功能响应缓慢
```bash
# 检查数据库索引
db.trades.getIndexes()
# 优化查询性能
db.trades.find({reasoning: {$regex: "趋势"}}).explain("executionStats")
```

## 📚 参考文档

### **内部文档**
```
CLAUDE.md          - 本配置文件 (当前)
README.md          - 项目概述
API文档           - 接口说明
部署指南          - 生产环境部署
```

### **外部资源**
```
Binance API文档    - https://binance-docs.github.io/apidocs/
Technical Analysis - 技术分析资料
React官方文档    - https://react.dev/
MongoDB手册      - https://docs.mongodb.com/
```

## 🎓 最佳实践总结

### **开发哲学**
1. **简洁优先**: 保持代码简洁，避免过度工程
2. **类型安全**: 充分利用TypeScript的类型系统
3. **错误预防**: 提前考虑边界情况和错误处理
4. **性能意识**: 关注关键路径的性能影响
5. **可维护性**: 为未来的维护和扩展做好准备

### **持续改进**
- 定期review代码质量
- 收集用户反馈并迭代
- 关注安全漏洞和更新
- 优化性能指标
- 完善文档和注释

---

**最后更新**: 2024年3月  
**版本**: v1.0  
**维护者**: Claude Code AI助手  
**状态**: 活跃开发中 ✅

这个CLAUDE.md文件为你的BTC交易监控系统提供了完整的项目规范和开发指导，确保团队开发的一致性和代码质量的持续提升。