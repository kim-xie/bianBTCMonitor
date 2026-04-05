/// <reference path="../types/express.d.ts" />
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import UserModel, { IUser } from '../models/User';
import UserSubscriptionModel from '../models/UserSubscription';
import SubscriptionPlanModel from '../models/SubscriptionPlan';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * 生成JWT令牌
 */
const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
};

/**
 * 用户注册
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, password } = req.body;

    // 验证输入
    if (!username || !email || !password) {
      res.status(400).json({ error: '用户名、邮箱和密码都是必需的' });
      return;
    }

    // 检查用户是否已存在
    const existingUserByUsername = await UserModel.findOne({ username });
    if (existingUserByUsername) {
      res.status(400).json({ error: '用户名已存在' });
      return;
    }

    const existingUserByEmail = await UserModel.findOne({ email });
    if (existingUserByEmail) {
      res.status(400).json({ error: '邮箱已被注册' });
      return;
    }

    // 创建新用户
    const user = new UserModel({
      username,
      email,
      password
    });

    await user.save();

    // 为新用户创建免费试用订阅
    try {
      // 查找免费试用套餐
      const freeTrialPlan = await SubscriptionPlanModel.findOne({ name: '免费试用' });
      if (freeTrialPlan) {
        // 计算结束日期（1天）
        const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        // 创建免费试用订阅
        const trialSubscription = new UserSubscriptionModel({
          userId: user._id,
          planId: freeTrialPlan._id,
          status: 'active',
          startDate: new Date(),
          endDate,
          autoRenewal: false,
          paymentMethod: null
        });
        
        await trialSubscription.save();
        
        // 更新用户订阅状态
        await UserModel.findByIdAndUpdate(user._id, {
          $set: { hasActiveSubscription: true }
        });
        
        console.log(`为用户 ${user.username} 创建了免费试用订阅，有效期至 ${endDate}`);
      }
    } catch (error) {
      console.error('创建免费试用订阅失败:', error);
      // 即使失败也不影响用户注册
    }

    // 生成JWT令牌
    const token = generateToken(user._id.toString());

    // 返回用户信息和令牌（不返回密码）
    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      hasActiveSubscription: true, // 新用户有免费试用
      createdAt: user.createdAt
    };

    res.status(201).json({
      message: '用户注册成功，已为您开通1天免费试用',
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 用户登录
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    // 验证输入
    if (!username || !password) {
      res.status(400).json({ error: '用户名和密码都是必需的' });
      return;
    }

    // 查找用户
    const user = await UserModel.findOne({ username });
    if (!user) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    // 验证密码
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    // 生成JWT令牌
    const token = generateToken(user._id.toString());

    // 返回用户信息和令牌（不返回密码）
    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt
    };

    res.json({
      message: '登录成功',
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 获取当前用户信息（包含订阅状态）
 */
export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: '用户未认证' });
      return;
    }

    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      hasActiveSubscription: user.hasActiveSubscription || false,
      createdAt: user.createdAt
    };

    res.json({ user: userResponse });
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};

/**
 * 同步用户订阅状态
 */
export const syncSubscriptionStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: '用户未认证' });
      return;
    }

    // 检查用户是否有活跃订阅
    const activeSubscription = await UserSubscriptionModel.findOne({
      userId: user._id,
      status: 'active'
    });

    const hasActiveSubscription = !!activeSubscription;

    // 更新用户模型中的订阅状态
    await UserModel.findByIdAndUpdate(user._id, {
      $set: { hasActiveSubscription }
    });

    res.json({
      success: true,
      hasActiveSubscription,
      subscription: activeSubscription ? {
        planId: activeSubscription.planId,
        endDate: activeSubscription.endDate,
        status: activeSubscription.status
      } : null
    });
  } catch (error) {
    console.error('同步订阅状态失败:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
};