import request from 'supertest';
import app from '../dashboard/server'; // 假设有一个导出app的入口

describe('用户认证系统', () => {
  let authToken: string;

  test('用户注册', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      });

    expect(response.status).toBe(201);
    expect(response.body.message).toBe('用户注册成功');
    expect(response.body.token).toBeDefined();
    expect(response.body.user.username).toBe('testuser');

    authToken = response.body.token;
  });

  test('用户登录', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'testuser',
        password: 'password123'
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('登录成功');
    expect(response.body.token).toBeDefined();
    expect(response.body.user.username).toBe('testuser');
  });

  test('获取当前用户信息', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe('testuser');
  });

  test('未授权访问受保护路由', async () => {
    const response = await request(app)
      .get('/api/auth/me');

    expect(response.status).toBe(401);
  });
});