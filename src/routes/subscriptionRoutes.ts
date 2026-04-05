import { Router } from 'express';
import {
  getSubscriptionPlans,
  getUserSubscription,
  createSubscription,
  cancelSubscription,
  getUserSubscriptionHistory
} from '../controllers/subscriptionController';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * @route   GET /api/subscription/plans
 * @desc    获取所有订阅套餐
 * @access  Public
 */
router.get('/plans', getSubscriptionPlans);

/**
 * @route   GET /api/subscription/current
 * @desc    获取用户当前订阅状态
 * @access  Private
 */
router.get('/current', authenticateToken, getUserSubscription);

/**
 * @route   POST /api/subscription/create
 * @desc    创建新的订阅
 * @access  Private
 */
router.post('/create', authenticateToken, createSubscription);

// /**
//  * @route   POST /api/subscription/create-mock
//  * @desc    创建模拟订阅（开发环境专用）
//  * @access  Private
//  */
// router.post('/create-mock', authenticateToken, createMockSubscription);

/**
 * @route   DELETE /api/subscription/cancel
 * @desc    取消订阅
 * @access  Private
 */
router.delete('/cancel', authenticateToken, cancelSubscription);

/**
 * @route   GET /api/subscription/history
 * @desc    获取用户订阅历史
 * @access  Private
 */
router.get('/history', authenticateToken, getUserSubscriptionHistory);

export default router;