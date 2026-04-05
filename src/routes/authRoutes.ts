import { Router } from 'express';
import { register, login, getCurrentUser } from '../controllers/authController';
import { authenticateToken, optionalAuth } from '../middleware/auth';

const router = Router();

/**
 * @route   POST /api/auth/register
 * @desc    用户注册
 * @access  Public
 */
router.post('/register', register);

/**
 * @route   POST /api/auth/login
 * @desc    用户登录
 * @access  Public
 */
router.post('/login', login);

/**
 * @route   GET /api/auth/me
 * @desc    获取当前用户信息
 * @access  Private
 */
router.get('/me', authenticateToken, getCurrentUser);

export default router;