import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import UserModel, { IUser } from '../models/User';

interface JwtPayload {
  userId: string;
}

// JWT密钥，应该从环境变量中读取
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

export interface AuthRequest extends Request {
  user?: IUser;
}

/**
 * 验证JWT令牌并附加用户信息到请求
 */
export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({ error: '访问令牌缺失' });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const user = await UserModel.findById(decoded.userId);
    if (!user) {
      res.status(401).json({ error: '用户不存在' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(403).json({ error: '无效的访问令牌' });
      return;
    }
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
};

/**
 * 可选认证 - 如果提供了token就验证，没有也不阻止请求
 */
export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      // 没有token，继续执行但不设置req.user
      next();
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const user = await UserModel.findById(decoded.userId);

    if (user) {
      req.user = user;
    }

    next();
  } catch (error) {
    // 验证失败，继续执行但不设置req.user
    next();
  }
};