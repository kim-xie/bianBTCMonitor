# 订阅管理系统完整功能

## 🎯 核心功能

### 📊 实时监控页面显示
- **用户栏目**: 显示订阅套餐名称、到期时间和剩余天数
- **状态指示**: 活跃（绿色）、即将过期（橙色闪烁）、已过期（红色闪烁）
- **警告提示**: 7天内到期自动显示续费提醒

### 🔒 访问控制机制
- **已订阅用户**: 完整功能访问权限
- **已过期用户**: 限制部分高级功能，提示续费
- **无订阅用户**: 基础功能使用权限

### ⏰ 到期时间计算
```javascript
// 服务器端计算
const now = new Date();
const endDate = new Date(subscription.endDate);
const timeLeft = endDate.getTime() - now.getTime();
const daysLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24)));
```

### 🛡️ 安全保护
- 所有API请求都需要有效订阅
- 数据重置操作需要活跃订阅
- 过期订阅自动降级为限制状态

## 📱 用户界面

### 监控页面（/dashboard）
```
[BTC交易监控系统]
┌─────────────────────────────────────┐
│ 当前资金: 1250.50 U                 │
├─────────────────────────────────────┤
│ 胜率: 65% (正确: 13/总计: 20)       │
├─────────────────────────────────────┤
│ 总交易次数: 20                     │
├─────────────────────────────────────┤
│ 当前价格: $65,432                  │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 订阅状态                          │
│ 高级版本                          │
│ 到期时间: 2024-01-15               │
│ 剩余: 15天                         │
└─────────────────────────────────────┘

[升级订阅套餐] [清空数据]
```

### 订阅管理页面（/management）
```
[订阅管理]
┌─────────────────────────────────────┐
│ 当前订阅                          │
│ 套餐: 月套餐                      │
│ 状态: 活跃                        │
│                                    │
│ 开始时间: 2024-01-01              │
│ 到期时间: 2024-02-01              │
│ 剩余时间: 15天                    │
│                                    │
│ [取消订阅]                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 订阅历史                          │
│ 套餐: 周套餐                      │
│ 状态: 已过期                      │
│ 结束时间: 2024-01-01              │
└─────────────────────────────────────┘
```

## 🔧 技术实现

### 数据库模型
```typescript
// UserSubscription 模型
{
  userId: string,
  planId: string,
  status: 'active' | 'expired' | 'cancelled',
  startDate: Date,
  endDate: Date,
  autoRenewal: boolean,
  paymentMethod: 'stripe' | 'paypal' | 'crypto'
}
```

### API端点
| 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|----------|
| GET | `/api/stats` | 获取统计数据（含订阅信息） | 可选 |
| GET | `/api/subscription/current` | 获取当前订阅状态 | 必需 |
| GET | `/api/subscription/history` | 获取订阅历史 | 必需 |
| POST | `/api/subscription/create` | 创建新订阅 | 必需 |
| DELETE | `/api/subscription/cancel` | 取消订阅 | 必需 |

### 中间件
```typescript
// checkSubscriptionStatus - 检查订阅状态
app.use(checkSubscriptionStatus);

// preventExpiredAccess - 防止过期访问
app.post('/api/reset-data', authenticateToken, preventExpiredAccess, ...);
```

## 🚀 使用流程

### 新用户订阅流程
1. **访问监控页面** `/dashboard`
2. **查看订阅状态** 显示"基础版本"
3. **点击升级按钮** 跳转到 `/subscription`
4. **选择套餐和支付方式**
5. **完成支付** 获得高级功能权限
6. **返回监控页面** 看到订阅状态更新

### 到期续费流程
1. **系统检测** 订阅即将过期（≤7天）
2. **显示警告** 在监控页面顶部
3. **用户续费** 通过 `/subscription` 页面
4. **状态更新** 续费后立即生效

### 订阅管理流程
1. **访问管理页面** `/management`
2. **查看详细信息** 套餐、到期时间等
3. **取消订阅** 确认后立即执行
4. **状态同步** 所有页面实时更新

## ⚠️ 错误处理

### 常见错误码
| 状态码 | 错误消息 | 解决方案 |
|--------|----------|----------|
| 401 | 未认证 | 登录后重试 |
| 403 | 订阅已过期 | 续费后重试 |
| 403 | 需要有效订阅 | 购买订阅 |
| 500 | 服务器内部错误 | 刷新页面或联系支持 |

### 前端错误处理
```javascript
// 自动重试机制
setTimeout(() => {
    this.loadStats();
}, 10000); // 每10秒重试一次

// 友好的错误提示
this.showError('无法加载统计数据');
```

## 📊 数据统计

### 订阅分析
- 活跃用户数
- 即将过期用户数
- 本月新增订阅
- 订阅续费率

### 使用分析
- 功能使用率
- 页面访问统计
- API调用频率
- 用户留存率

## 🔄 自动化任务

### 定时检查
```javascript
// 每30秒检查订阅状态
setInterval(() => {
    checkSubscriptionStatus();
}, 30000);

// 每5分钟同步订阅数据
setInterval(() => {
    syncSubscriptionData();
}, 300000);
```

### 自动更新
- 订阅状态实时同步到用户模型
- 过期订阅自动标记为expired状态
- 用户页面自动刷新订阅信息

## 🛠️ 维护和管理

### 手动操作
```bash
# 重启服务器
npm run dashboard

# 清除缓存
node scripts/clear-cache.js
```

### 数据备份
```bash
# 备份订阅数据
mongodump --db btc-trading --collection userSubscriptions

# 恢复订阅数据
mongorestore --db btc-trading --collection userSubscriptions dump/btc-trading/userSubscriptions.bson
```

### 监控日志
```bash
# 查看服务器日志
tail -f logs/dashboard.log

# 订阅相关日志
grep "subscription" logs/dashboard.log
```

这个完整的订阅管理系统提供了：
✅ 实时订阅状态显示
✅ 智能访问控制
✅ 友好用户提示
✅ 安全保护机制
✅ 完善的错误处理

所有功能都已集成到现有的BTC交易监控系统中！