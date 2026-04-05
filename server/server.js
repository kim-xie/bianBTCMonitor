const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/btc_trading';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, minlength: 3 },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true, minlength: 6 },
  createdAt: { type: Date, default: Date.now },
  balance: { type: Number, default: 100 },
  totalTrades: { type: Number, default: 0 },
  winRate: { type: Number, default: 0 },
  totalProfitLoss: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Validation middleware
const validateRegistration = [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

const validateLogin = [
  body('username').notEmpty().withMessage('Username required'),
  body('password').notEmpty().withMessage('Password required')
];

// Routes

// Register
app.post('/api/auth/register', validateRegistration, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = new User({
      username,
      email,
      password: hashedPassword
    });

    await user.save();

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', validateLogin, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password } = req.body;

    // Find user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        totalTrades: user.totalTrades,
        winRate: user.winRate,
        totalProfitLoss: user.totalProfitLoss
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout (client-side token removal is sufficient for JWT)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logout successful' });
});

// Update user balance (for trading)
app.put('/api/auth/balance', authenticateToken, async (req, res) => {
  try {
    const { balance } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { balance },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mock data endpoints (keeping existing functionality)
let mockStats = {
  totalTrades: 156,
  winRate: 78.5,
  winningTrades: 122,
  losingTrades: 34,
  openTrades: 3,
  totalProfitLoss: 45.2,
  totalInvestment: 780,
  currentBalance: 145.2
};

let mockTrades = [
  {
    _id: '1',
    timestamp: new Date('2024-01-15T10:30:00'),
    price: 42500,
    investmentAmount: 5,
    tradeType: 'LONG',
    reasoning: ['RSI oversold', 'Support level bounce', 'Volume spike'],
    confidence: 85,
    closePrice: 42800,
    closeTime: new Date('2024-01-15T11:45:00'),
    isCorrect: true,
    profitLoss: 3.0
  },
  {
    _id: '2',
    timestamp: new Date('2024-01-15T14:20:00'),
    price: 42800,
    investmentAmount: 5,
    tradeType: 'SHORT',
    reasoning: ['Resistance rejection', 'Bearish divergence'],
    confidence: 72,
    closePrice: 42650,
    closeTime: new Date('2024-01-15T15:30:00'),
    isCorrect: true,
    profitLoss: 1.5
  }
];

// Existing API endpoints (modified for user-specific data)
app.get('/api/stats', authenticateToken, (req, res) => {
  res.json(mockStats);
});

app.get('/api/recent-trades', authenticateToken, (req, res) => {
  res.json(mockTrades.slice(0, 5));
});

app.get('/api/all-trades', authenticateToken, (req, res) => {
  res.json(mockTrades);
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send initial data
  socket.emit('statsUpdate', mockStats);
  socket.emit('tradesUpdate', mockTrades.slice(0, 5));

  // Mock trading signal
  const mockSignal = {
    signal: 'BUY',
    currentPrice: 43200,
    prediction: 'UP',
    confidence: 87,
    reasoning: [
      'Golden cross pattern detected',
      'Volume increasing on upward moves',
      'RSI showing bullish momentum',
      'Key resistance broken with high volume'
    ],
    recommendedAction: 'Consider opening a long position with 5U investment'
  };

  socket.emit('tradingSignal', mockSignal);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Update balance via WebSocket
io.on('connection', (socket) => {
  socket.on('updateBalance', (data) => {
    const { balance, userId } = data;
    socket.broadcast.emit('balanceUpdate', {
      balance,
      timestamp: new Date().toISOString()
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;