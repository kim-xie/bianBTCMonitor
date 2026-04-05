# 分级访问控制说明

## 🎯 新功能：灵活的用户访问权限

### 📋 访问权限分级

| 用户状态 | 可访问功能 | 购买限制 |
|----------|------------|----------|
| **未登录** | 查看套餐信息、价格对比 | ❌ 不能购买 |
| **已登录（无订阅）** | 查看套餐、选择支付方式、购买订阅 | ✅ 可以购买 |
| **已登录（有订阅）** | 查看套餐、管理订阅、仪表板访问 | ⚠️ 不能重复购买 |

### 🔄 访问流程

#### 1. 访客访问 (无需登录)
- ✅ 浏览所有套餐信息
- ✅ 比较价格和功能
- ✅ 了解服务详情
- ❌ 不能进行购买操作

#### 2. 登录后访问 (完整功能)
- ✅ 查看个人订阅状态
- ✅ 选择并购买新套餐
- ✅ 管理现有订阅
- ✅ 访问高级功能

#### 3. 已订阅用户访问
- ✅ 查看"已订阅"状态
- ✅ 访问仪表板和所有功能
- ✅ 查看订阅详情
- ❌ 不能重复购买（避免冲突）

### 🛡️ 安全机制

#### 认证保护
```javascript
// 所有购买相关API都需要JWT认证
app.post('/api/subscription/create', authenticateToken, createSubscription);
```

#### 订阅状态验证
```javascript
// 购买前检查用户是否已有活跃订阅
if (user.hasActiveSubscription) {
    return res.status(400).json({ error: '您已经有一个活跃的订阅' });
}
```

### 💻 前端用户体验

#### 登录状态显示
```html
<!-- 未登录时显示 -->
<div id="authPrompt">
    <button onclick="window.location.href='/login'">
        <i class="fas fa-sign-in-alt"></i> 登录后购买套餐
    </button>
</div>

<!-- 已登录且无订阅时显示 -->
<div class="payment-section">
    <h2>选择支付方式</h2>
    <!-- 支付选项 -->
    <button class="checkout-btn">安全支付</button>
</div>

<!-- 已订阅时显示 -->
<div class="success-message">
    <h2>🎉 您已订阅高级服务！</h2>
    <p>欢迎回来，{用户名}！</p>
    <button onclick="window.location.href='/dashboard'">
        <i class="fas fa-home"></i> 进入仪表板
    </button>
</div>
```

### 🔧 技术实现

#### 后端API端点
- `GET /api/auth/me` - 获取用户信息（包含订阅状态）
- `POST /api/subscription/sync-status` - 同步订阅状态到用户模型
- `GET /api/subscription/current` - 获取当前订阅详情
- `POST /api/subscription/create` - 创建新订阅（需验证无活跃订阅）

#### 前端逻辑
```javascript
// 初始化时检查认证状态
async init() {
    if (token) {
        await this.checkSubscriptionStatus();
    } else {
        // 显示登录提示
        this.showLoginPrompt();
    }
}

// 购买前验证
async checkout() {
    if (!token) {
        redirect to login;
        return;
    }

    // 检查是否有活跃订阅
    const userInfo = await getUserInfo();
    if (userInfo.hasActiveSubscription) {
        show already subscribed message;
        return;
    }

    // 继续购买流程...
}
```

### 🚀 使用示例

#### 场景1：新用户注册并购买
1. 访问 `/subscription` 查看套餐
2. 点击"登录后购买套餐"
3. 完成注册/登录
4. 选择套餐和支付方式
5. 完成购买，获得高级功能

#### 场景2：已订阅用户返回
1. 访问 `/subscription`
2. 自动检测到活跃订阅
3. 显示"欢迎回来"消息
4. 可以直接访问仪表板

#### 场景3：访客浏览
1. 访问 `/subscription`
2. 查看所有套餐信息和价格
3. 了解服务详情
4. 需要时点击登录按钮开始购买

### 🔒 安全保障

1. **双重验证** - JWT认证 + 订阅状态检查
2. **数据一致性** - 定期同步订阅状态到用户模型
3. **防止滥用** - 限制重复购买
4. **错误处理** - 清晰的错误提示和引导

### 📱 移动端适配

所有页面都支持移动设备：
- 响应式布局
- 触摸友好界面
- 快速加载性能
- 离线缓存支持

这个分级访问控制系统既保证了系统的安全性，又提供了灵活的访问体验！