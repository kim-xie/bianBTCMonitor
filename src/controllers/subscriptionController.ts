import { Request, Response } from 'express';
import SubscriptionPlanModel, { createDefaultPlans } from '../models/SubscriptionPlan';
import UserSubscriptionModel from '../models/UserSubscription';
import UserModel from '../models/User';

// 检查是否为线上环境
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

interface AuthRequest extends Request {
  user?: any;
}

/**
 * 获取所有订阅套餐
 */
export const getSubscriptionPlans = async (req: Request, res: Response): Promise<void> => {
  try {
    const plans = await SubscriptionPlanModel.find({ isActive: true }).lean();

    if (plans.length === 0) {
      // 如果没有套餐，创建默认套餐
      await createDefaultPlans(SubscriptionPlanModel);
      const newPlans = await SubscriptionPlanModel.find({ isActive: true }).lean();
      res.json(newPlans);
      return;
    }

    res.json(plans);
  } catch (error) {
    console.error('获取订阅套餐失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 获取用户当前订阅状态
 */
export const getUserSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: '未授权访问' });
      return;
    }

    const subscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    })
    .populate('planId')
    .lean();

    res.json({
      hasActiveSubscription: !!subscription,
      subscription: subscription || null
    });
  } catch (error) {
    console.error('获取用户订阅失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 创建新的订阅
 */
export const createSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: '未授权访问' });
      return;
    }

    const { planId, paymentMethod, autoRenewal } = req.body;

    // 验证套餐ID
    const plan = await SubscriptionPlanModel.findById(planId);
    if (!plan || !plan.isActive) {
      res.status(404).json({ error: '套餐不存在或已停用' });
      return;
    }

    // 计算结束日期
    let endDate: Date;
    switch (plan.duration) {
      case 'weekly':
        endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        break;
      case 'quarterly':
        endDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }

    // 检查用户是否已有活跃订阅
    const existingSubscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    });

    if (existingSubscription) {
      res.status(400).json({ error: '您已经有一个活跃的订阅' });
      return;
    }

    // 创建新订阅
    const subscription = new UserSubscriptionModel({
      userId: req.user._id,
      planId: plan._id,
      status: 'active',
      startDate: new Date(),
      endDate,
      autoRenewal: autoRenewal || false,
      paymentMethod: isProduction ? paymentMethod : 'mock'
    });

    await subscription.save();

    // 更新用户订阅状态
    await UserModel.findByIdAndUpdate(req.user._id, {
      $set: { hasActiveSubscription: true }
    });

    // 返回套餐信息和订阅详情
    const result = await UserSubscriptionModel.findById(subscription._id)
      .populate('planId')
      .lean();

    res.status(201).json({
      message: isProduction ? '订阅创建成功' : '模拟订阅创建成功（开发环境）',
      subscription: result,
      plan: plan,
      environment: isProduction ? 'production' : 'development'
    });

  } catch (error) {
    console.error('创建订阅失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 创建模拟订阅（开发环境专用）
 */
export const createMockSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // 只在开发环境允许
    if (isProduction) {
      res.status(403).json({ error: '此功能仅在开发环境可用' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: '未授权访问' });
      return;
    }

    const { planId } = req.body;

    // 验证套餐ID
    const plan = await SubscriptionPlanModel.findById(planId);
    if (!plan || !plan.isActive) {
      res.status(404).json({ error: '套餐不存在或已停用' });
      return;
    }

    // 计算结束日期（开发环境给3天）
    const endDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // 检查用户是否已有活跃订阅
    const existingSubscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    });

    if (existingSubscription) {
      res.status(400).json({ error: '您已经有一个活跃的订阅' });
      return;
    }

    // 创建模拟订阅
    const subscription = new UserSubscriptionModel({
      userId: req.user._id,
      planId: plan._id,
      status: 'active',
      startDate: new Date(),
      endDate,
      autoRenewal: false,
      paymentMethod: 'mock'
    });

    await subscription.save();

    // 更新用户订阅状态
    await UserModel.findByIdAndUpdate(req.user._id, {
      $set: { hasActiveSubscription: true }
    });

    // 返回套餐信息和订阅详情
    const result = await UserSubscriptionModel.findById(subscription._id)
      .populate('planId')
      .lean();

    res.status(201).json({
      message: '模拟订阅创建成功，有效期3天',
      subscription: result,
      plan: plan,
      environment: 'development'
    });

  } catch (error) {
    console.error('创建模拟订阅失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 取消订阅
 */
export const cancelSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: '未授权访问' });
      return;
    }

    const subscription = await UserSubscriptionModel.findOne({
      userId: req.user._id,
      status: 'active'
    });

    if (!subscription) {
      res.status(404).json({ error: '未找到活跃订阅' });
      return;
    }

    subscription.status = 'cancelled';
    subscription.endDate = new Date(); // 立即结束
    await subscription.save();

    // 更新用户订阅状态
    await UserModel.findByIdAndUpdate(req.user._id, {
      $set: { hasActiveSubscription: false }
    });

    res.json({
      message: '订阅已成功取消',
      subscription: subscription
    });

  } catch (error) {
    console.error('取消订阅失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 获取用户订阅历史
 */
export const getUserSubscriptionHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: '未授权访问' });
      return;
    }

    const history = await UserSubscriptionModel.find({
      userId: req.user._id
    })
    .populate('planId')
    .sort({ createdAt: -1 })
    .lean();

    res.json(history);

  } catch (error) {
    console.error('获取订阅历史失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};