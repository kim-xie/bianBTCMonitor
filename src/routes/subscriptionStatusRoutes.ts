import { Router } from 'express';
import { syncSubscriptionStatus } from '../controllers/authController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * @route   POST /api/subscription/sync-status
 * @desc    同步用户订阅状态
 * @access  Private
 */
router.post('/sync-status', authenticateToken, syncSubscriptionStatus);

export default router;