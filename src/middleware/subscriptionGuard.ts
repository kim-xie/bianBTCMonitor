import { Request, Response, NextFunction } from 'express';
import UserSubscriptionModel from '../models/UserSubscription';
import UserModel from '../models/User';

interface AuthRequest extends Request {
  user?: any;
}

/**
 * 检查用户订阅状态的中间件
 */
export const checkSubscriptionStatus = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // 如果没有认证，允许访问基础页面
    if (!req.user) {
      return next();
    }

    // 查找用户的活跃订阅
    const activeSubscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    }).lean();

    if (!activeSubscription) {
      // 用户没有活跃订阅，更新用户模型状态
      await UserModel.findByIdAndUpdate(req.user._id, {
        $set: { hasActiveSubscription: false }
      });
      return next();
    }

    // 检查订阅是否过期
    const now = new Date();
    const endDate = new Date(activeSubscription.endDate);
    const isExpired = endDate <= now;

    if (isExpired) {
      // 订阅已过期，更新状态
      await UserSubscriptionModel.findByIdAndUpdate(activeSubscription._id, {
        $set: { status: 'expired' }
      });
      await UserModel.findByIdAndUpdate(req.user._id, {
        $set: { hasActiveSubscription: false }
      });

      // 如果是API请求且已过期，返回错误
      if (req.path.startsWith('/api/') && req.method !== 'GET') {
        res.status(403).json({ error: '您的订阅已过期，请续费后继续使用' });
        return;
      }
    } else {
      // 更新用户模型中的订阅状态
      await UserModel.findByIdAndUpdate(req.user._id, {
        $set: { hasActiveSubscription: true }
      });
    }

    next();
  } catch (error) {
    console.error('检查订阅状态失败:', error);
    // 出现错误时允许继续，避免影响用户体验
    next();
  }
};

/**
 * 限制已过期用户访问的中间件
 */
export const preventExpiredAccess = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // 只对API请求进行检查
    if (!req.path.startsWith('/api/')) {
      return next();
    }

    // 如果没有认证，允许基础API访问
    if (!req.user) {
      return next();
    }

    // 检查用户是否有活跃订阅
    const activeSubscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    }).lean();

    if (!activeSubscription) {
      res.status(403).json({ error: '需要有效订阅才能访问此功能' });
      return;
    }

    // 检查是否过期
    const now = new Date();
    const endDate = new Date(activeSubscription.endDate);
    const isExpired = endDate <= now;

    if (isExpired) {
      res.status(403).json({ error: '您的订阅已过期，请续费后继续使用' });
      return;
    }

    next();
  } catch (error) {
    console.error('防止过期访问检查失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
};