import { Router } from 'express';
import {
  createStripePaymentIntent,
  createPayPalOrder,
  createCryptoPayment,
  verifyPaymentStatus
} from '../controllers/paymentController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * @route   POST /api/payment/stripe/create-intent
 * @desc    创建Stripe支付意图
 * @access  Private
 */
router.post('/stripe/create-intent', authenticateToken, createStripePaymentIntent);

/**
 * @route   POST /api/payment/paypal/create-order
 * @desc    创建PayPal订单
 * @access  Private
 */
router.post('/paypal/create-order', authenticateToken, createPayPalOrder);

/**
 * @route   POST /api/payment/crypto/generate-address
 * @desc    生成加密货币支付地址
 * @access  Private
 */
router.post('/crypto/generate-address', authenticateToken, createCryptoPayment);

/**
 * @route   POST /api/payment/verify-status
 * @desc    验证支付状态
 * @access  Private
 */
router.post('/verify-status', authenticateToken, verifyPaymentStatus);

export default router;