# 用户认证系统

## 功能概述

本项目集成了完整的用户注册和登录系统，包括JWT认证和API保护。

## 主要特性

- 🔐 **用户注册** - 创建新用户账户
- 🔑 **用户登录** - 安全的用户认证
- 🛡️ **JWT认证** - JSON Web Token认证机制
- 🔒 **路由保护** - 受保护的关键API端点
- 📧 **输入验证** - 用户名、邮箱和密码验证

## API 端点

### 用户注册
```http
POST /api/auth/register
```

**请求体:**
```json
{
  "username": "your_username",
  "email": "your_email@example.com",
  "password": "your_password"
}
```

**成功响应 (201):**
```json
{
  "message": "用户注册成功",
  "token": "jwt_token_here",
  "user": {
    "id": "user_id",
    "username": "your_username",
    "email": "your_email@example.com",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### 用户登录
```http
POST /api/auth/login
```

**请求体:**
```json
{
  "username": "your_username",
  "password": "your_password"
}
```

**成功响应 (200):**
```json
{
  "message": "登录成功",
  "token": "jwt_token_here",
  "user": {
    "id": "user_id",
    "username": "your_username",
    "email": "your_email@example.com",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### 获取当前用户信息
```http
GET /api/auth/me
Authorization: Bearer your_jwt_token
```

**成功响应 (200):**
```json
{
  "user": {
    "id": "user_id",
    "username": "your_username",
    "email": "your_email@example.com",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

## 受保护的路由

以下API端点需要有效的JWT令牌才能访问:

- `POST /api/reset-data` - 清空所有交易数据（仅限认证用户）

## 环境变量配置

在 `.env` 文件中设置以下配置项:

```bash
# JWT配置
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d
```

## 技术实现

### 依赖包
- **bcryptjs** - 密码加密和安全存储
- **jsonwebtoken** - JWT令牌生成和验证
- **mongoose** - MongoDB对象建模工具

### 安全特性
- 密码使用bcrypt算法加密
- JWT令牌包含过期时间控制
- 输入验证防止恶意数据注入
- 唯一约束防止重复注册

### 数据库模型
- **用户名** (username): 3-30字符，唯一
- **邮箱** (email): 有效邮箱格式，唯一
- **密码** (password): 最小6字符长度
- **创建时间** (createdAt): 自动记录注册时间

## 错误处理

### 常见错误码

| 状态码 | 错误消息 | 说明 |
|--------|----------|------|
| 400 | 用户名已存在 | 用户名已被注册 |
| 400 | 邮箱已被注册 | 邮箱已被其他用户使用 |
| 400 | 用户名、邮箱和密码都是必需的 | 缺少必填字段 |
| 401 | 用户名或密码错误 | 登录凭据无效 |
| 401 | 访问令牌缺失 | 未提供JWT令牌 |
| 403 | 无效的访问令牌 | JWT令牌无效或过期 |
| 500 | 服务器内部错误 | 服务器端错误 |

## 测试

运行认证系统的测试:

```bash
npm test -- src/test/auth.test.ts
```

## 部署注意事项

1. **更改JWT密钥**: 在生产环境中务必更改默认的JWT_SECRET值
2. **数据库安全**: 确保MongoDB连接安全，使用强密码
3. **HTTPS**: 在生产环境中使用HTTPS传输认证令牌
4. **令牌过期**: 根据需求调整JWT_EXPIRES_IN设置

## 集成到前端

前端应用需要在每次API调用时携带JWT令牌:

```javascript
// 示例: 使用fetch发送认证请求
const response = await fetch('/api/auth/me', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
    'Content-Type': 'application/json'
  }
});
```

## 后续扩展建议

- [ ] 添加邮箱验证功能
- [ ] 实现密码重置功能
- [ ] 添加用户角色和权限管理
- [ ] 实现会话管理和刷新令牌
- [ ] 添加登录历史记录