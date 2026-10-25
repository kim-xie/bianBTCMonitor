import 'dotenv/config'; // 加载.env文件配置
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import { TradingSignalService } from '../services/TradingSignal';
import { StatisticsService } from '../services/StatisticsService';
import { BinanceService } from '../services/BinanceService';
import PriceDataModel from '../models/PriceData';
import TradeModel from '../models/Trade';

/**
 * 获取北京时间今天0点对应的 Date 对象。
 * 无论服务器位于哪个时区，都返回北京时间0点对应的绝对时刻，
 * 避免生产环境(Render, UTC)与本地环境(UTC+8)的“今日”统计口径不一致。
 */
const getBeijingTodayStart = (): Date => {
  const now = new Date();
  // now + 8h 后取 UTC 分量 => 北京时间的年月日
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  // 北京时间今天0点 = 该日期的 UTC 零点 - 8小时
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 3600 * 1000);
};

/**
 * 将 YYYY-MM-DD 字符串按北京时间解析为 Date。
 * isEnd=true 时返回北京时间当天 23:59:59，用于 endDate 包含全天数据。
 */
const parseBeijingDate = (dateStr: string, isEnd = false): Date => {
  const [y, m, d] = dateStr.split('-').map(Number);
  // 北京时间当天 00:00 = UTC 前一天 16:00
  const start = new Date(Date.UTC(y, m - 1, d) - 8 * 3600 * 1000);
  if (!isEnd) return start;
  // 北京时间当天 23:59:59.999
  return new Date(start.getTime() + 24 * 3600 * 1000 - 1);
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 中间件
app.use(cors());
app.use(express.json());

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 认证路由
import authRoutes from '../routes/authRoutes';
app.use('/api/auth', authRoutes);

// 订阅套餐路由
import subscriptionRoutes from '../routes/subscriptionRoutes';
app.use('/api/subscription', subscriptionRoutes);

// 订阅状态路由
import subscriptionStatusRoutes from '../routes/subscriptionStatusRoutes';
app.use('/api/subscription', subscriptionStatusRoutes);

// 支付路由
import paymentRoutes from '../routes/paymentRoutes';
app.use('/api/payment', paymentRoutes);

// 确保 index.html 可以被访问
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 数据库连接
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/btc-trading';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('MongoDB连接成功');
    // 初始化资金状态
    await calculateCurrentBalance();
    console.log(`初始资金状态: ${currentBalance.toFixed(2)}U`);
  })
  .catch(err => console.error('MongoDB连接失败:', err));

// 服务实例
const tradingSignalService = new TradingSignalService();

// 已播报平仓结果的交易ID（内存去重，仅dashboard进程广播语音用）
const announcedClosedTradeIds = new Set<string>();

const emitTradeClosed = (trade: any) => {
  const id = String(trade._id);
  if (announcedClosedTradeIds.has(id)) return;
  announcedClosedTradeIds.add(id);
  io.emit('tradeClosed', {
    profitLoss: trade.profitLoss,
    isCorrect: trade.isCorrect,
    tradeType: trade.tradeType,
    signal: trade.signal
  });
};
const statisticsService = new StatisticsService();

// 定期清理过期的K线使用记录（每小时一次）
setInterval(() => {
  tradingSignalService.cleanupExpiredKlines();
  console.log('已清理过期的K线使用记录');
}, 60 * 60 * 1000); // 每小时清理一次

// 添加资金跟踪
let currentBalance = 100; // 初始资金100U

// 计算当前资金基于所有已完成交易
const calculateCurrentBalance = async () => {
  try {
    const completedTrades = await TradeModel.find({
      isCorrect: { $exists: true },
      profitLoss: { $exists: true }
    }).lean();

    let balance = 100; // 初始资金
    completedTrades.forEach(trade => {
      balance += (trade.profitLoss || 0);
    });

    currentBalance = balance;
    return balance;
  } catch (error) {
    console.error('计算资金失败:', error);
    return currentBalance;
  }
};

// 计算完整的资金历史变化
const calculateBalanceHistory = async () => {
  try {
    const completedTrades = await TradeModel.find({
      isCorrect: { $exists: true },
      profitLoss: { $exists: true }
    }).sort({ closeTime: 1 }).lean(); // 按平仓时间排序

    const history = [];
    let balance = 100; // 初始资金

    if (completedTrades.length > 0) {
      // 有交易记录的情况
      // 添加初始资金点（使用第一笔交易时间前10分钟作为起点）
      const firstTradeTime = new Date(completedTrades[0].closeTime || completedTrades[0].timestamp);
      const startTime = new Date(firstTradeTime.getTime() - 10 * 60 * 1000); // 第一笔交易前10分钟
      
      history.push({
        time: startTime.toISOString(),
        balance: 100 // 初始资金固定为100
      });

      // 按时间顺序重建资金变化历史
      for (const trade of completedTrades) {
        balance += (trade.profitLoss || 0);
        history.push({
          time: trade.closeTime || new Date().toISOString(),
          balance: balance
        });
      }
    } else {
      // 没有交易记录的情况，只显示初始资金点
      history.push({
        time: new Date().toISOString(),
        balance: 100
      });
    }

    return history;
  } catch (error) {
    console.error('计算资金历史失败:', error);
    return [];
  }
};

// 代理配置（可选）
const proxyConfig = process.env.PROXY_HOST ? {
  host: process.env.PROXY_HOST,
  port: parseInt(process.env.PROXY_PORT || '8080'),
  auth: process.env.PROXY_USER ? {
    username: process.env.PROXY_USER,
    password: process.env.PROXY_PASS || ''
  } : undefined
} : undefined;

const binanceService = new BinanceService(proxyConfig);

// API路由
// 认证相关导入
import { AuthRequest } from '../middleware/auth';
import UserSubscriptionModel from '../models/UserSubscription';

app.get('/api/stats', async (req: AuthRequest, res) => {
  try {
    // 计算今日的开始时间（北京时间0点，跨时区一致）
    const today = getBeijingTodayStart();

    const [stats, todayStats, balance, balanceHistory] = await Promise.all([
      statisticsService.calculateWinRate(),
      statisticsService.calculateWinRate({ start: today, end: new Date() }),
      calculateCurrentBalance(),
      calculateBalanceHistory()
    ]);

    // 为所有用户提供基础统计数据（包括未订阅用户）
    let subscriptionInfo = null;

    // 只有已登录且有活跃订阅的用户才显示详细信息
    if (req.user) {
      try {
        const activeSubscription = await UserSubscriptionModel.findOne({
          userId: req.user._id,
          status: 'active'
        }).lean();

        if (activeSubscription) {
          const now = new Date();
          const endDate = new Date(activeSubscription.endDate);
          const timeLeft = endDate.getTime() - now.getTime();

          subscriptionInfo = {
            hasActiveSubscription: true,
            planId: activeSubscription.planId,
            endDate: activeSubscription.endDate,
            timeLeft: Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24))),
            isExpired: timeLeft <= 0
          };
        } else {
          // 已登录但没有活跃订阅
          subscriptionInfo = {
            hasActiveSubscription: false
          };
        }
      } catch (subscriptionError) {
        console.error('获取订阅信息失败:', subscriptionError);
        subscriptionInfo = {
          hasActiveSubscription: false
        };
      }
    } else {
      // 未登录用户（访客模式）
      subscriptionInfo = {
        hasActiveSubscription: false,
        guestMode: true
      };
    }

    res.json({
      ...stats,
      currentBalance: balance,
      balanceHistory: balanceHistory,
      subscription: subscriptionInfo,
      todayStats: {
        totalTrades: todayStats.totalTrades,
        winningTrades: todayStats.winningTrades,
        losingTrades: todayStats.losingTrades,
        winRate: todayStats.winRate,
        totalProfitLoss: todayStats.totalProfitLoss,
        averageConfidence: todayStats.averageConfidence
      }
    });
  } catch (error) {
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

app.get('/api/recent-trades', async (_req, res) => {
  try {
    const trades = await statisticsService.getRecentTrades(20);
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: '获取交易记录失败' });
  }
});

/**
 * 搜索交易记录接口
 */
app.get('/api/trades/search', async (req, res) => {
  try {
    // 解析查询参数
    const {
      reasoningKeyword,
      signal,
      tradeType,
      confidenceMin,
      confidenceMax,
      startDate,
      endDate,
      limit = 50,
      sortBy = 'timestamp',
      sortOrder = 'desc'
    } = req.query;

    // 构建过滤器对象
    const filters: any = {};

    if (reasoningKeyword) {
      filters.reasoningKeyword = reasoningKeyword as string;
    }

    if (signal && ['BUY', 'SELL'].includes(signal as string)) {
      filters.signal = signal as 'BUY' | 'SELL';
    }

    if (tradeType && ['LONG', 'SHORT'].includes(tradeType as string)) {
      filters.tradeType = tradeType as 'LONG' | 'SHORT';
    }

    if (confidenceMin !== undefined) {
      filters.confidenceMin = parseFloat(confidenceMin as string);
    }

    if (confidenceMax !== undefined) {
      filters.confidenceMax = parseFloat(confidenceMax as string);
    }

    if (startDate) {
      filters.startDate = parseBeijingDate(startDate as string);
    }

    if (endDate) {
      filters.endDate = parseBeijingDate(endDate as string, true);
    }

    filters.limit = parseInt(limit as string);
    filters.sortBy = sortBy as 'timestamp' | 'confidence' | 'profitLoss';
    filters.sortOrder = sortOrder as 'asc' | 'desc';

    // 执行搜索
    const trades = await statisticsService.searchTrades(filters);

    res.json({
      success: true,
      count: trades.length,
      data: trades
    });

  } catch (error) {
    console.error('搜索交易记录失败:', error);
    res.status(500).json({
      success: false,
      error: '搜索交易记录失败'
    });
  }
});

// 获取所有交易用于日历统计
app.get('/api/all-trades', async (_req, res) => {
  try {
    const trades = await TradeModel.find({}).sort({ timestamp: 1 }).lean();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: '获取交易记录失败' });
  }
});

// 临时清空数据接口（用于重置）
// 认证和订阅相关导入
import { authenticateToken } from '../middleware/auth';
import { checkSubscriptionStatus } from '../middleware/subscriptionGuard';

// 应用订阅状态检查中间件到所有API路由
app.use(checkSubscriptionStatus);

app.post('/api/reset-data', authenticateToken, async (req: AuthRequest, res) => {
  try {
    // 只允许认证用户执行数据重置（不限制订阅状态）
    if (!req.user) {
      res.status(401).json({ error: '未授权操作' });
      return;
    }

    // 清空交易记录
    const tradesResult = await TradeModel.deleteMany({});
    // 清空价格数据
    const priceResult = await PriceDataModel.deleteMany({});

    // 重置当前资金为初始值
    currentBalance = 100;

    console.log(`用户 ${req.user.username} 已清空数据: ${tradesResult.deletedCount} 条交易, ${priceResult.deletedCount} 条价格数据`);

    res.json({
      success: true,
      message: '数据已清空，已重新开始',
      deletedTrades: tradesResult.deletedCount,
      deletedPrices: priceResult.deletedCount,
      currentBalance: currentBalance
    });
  } catch (error) {
    console.error('清空数据失败:', error);
    res.status(500).json({ error: '清空数据失败' });
  }
});

app.get('/api/current-price', async (_req, res) => {
  try {
    const latestPrice = await PriceDataModel
      .findOne()
      .sort({ timestamp: -1 })
      .lean();

    res.json({ price: latestPrice?.price || 65000 });
  } catch (error) {
    res.status(500).json({ error: '获取当前价格失败' });
  }
});

app.get('/api/klines', async (req, res) => {
  try {
    const interval = typeof req.query.interval === 'string' ? req.query.interval : '10m';
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 200, 500);
    const start = parseInt(String(req.query.start), 10) || undefined;
    const end = parseInt(String(req.query.end), 10) || undefined;
    const klines = await binanceService.getKlines(interval, limit, start, end);
    const trades = await TradeModel.find().sort({ timestamp: -1 }).limit(100).lean();
    res.json({ klines, trades });
  } catch (error) {
    console.error('获取K线数据失败:', error);
    res.status(500).json({ error: '获取K线数据失败' });
  }
});

// Socket.io连接
io.on('connection', (socket: any) => {
  console.log('客户端已连接:', socket.id);

  socket.on('disconnect', () => {
    console.log('客户端已断开:', socket.id);
  });
});

// 实时价格更新
let currentPrice = 65000;
const updatePrice = async () => {
  try {
    const ticker = await binanceService.getCurrentPrice();
    const priceData = binanceService.convertToPriceData(ticker);

    currentPrice = priceData.price || currentPrice;

    io.emit('priceUpdate', {
      price: currentPrice,
      timestamp: new Date().toISOString()
    });

    // 保存到数据库
    await PriceDataModel.create(priceData);
  } catch (error) {
    console.error('获取价格失败:', error);
  }
};

// 启动价格更新定时器
setInterval(updatePrice, 5000); // 每5秒更新一次真实价格

/**
 * 确保获取的是已收盘的5分钟K线
 */
async function getClosedFiveMinuteKlines() {
  // 获取K线数据（多获取一些以确保有已收盘的，EMA200需要至少200根）
  const klines = await binanceService.getKlines('5m', 400);

  console.log(`📊 获取到${klines.length}根5分钟K线`);

  // 当前UTC时间
  const now = new Date().getTime();
  console.log(`🕐 当前时间: ${new Date(now).toLocaleString()}`);

  // 筛选已收盘的K线 - 使用closeTime字段确保准确性
  const closedKlines = klines.filter(kline => {
    // 使用K线的实际结束时间（closeTime）而不是计算值
    const endTime = kline.closeTime;
    // 结束时间小于当前时间，说明已收盘
    return endTime < now;
  });

  if (closedKlines.length === 0) {
    console.log('⚠️  没有找到已收盘的5分钟K线，尝试放宽条件...');

    // 显示最后几根K线的状态用于调试
    console.log('🔍 最后3根K线的状态:');
    for (let i = Math.max(0, klines.length - 3); i < klines.length; i++) {
      const kline = klines[i];
      const endTime = kline.closeTime;
      const isClosed = endTime < now;
      const status = isClosed ? '✅ 已收盘' : '⏳ 进行中';
      const timeDiff = isClosed ? '' : ` (${Math.floor((now - endTime) / 1000)}秒前结束)`;
      console.log(`   K线${i + 1}: ${status}, closeTime: ${new Date(endTime).toLocaleString()}${timeDiff}`);
    }

    // 如果没有找到完全已收盘的K线，找那些即将结束的K线（允许最多1分钟未完成）
    const almostClosedKlines = klines.filter(kline => {
      const endTime = kline.closeTime;
      const timeDiff = now - endTime;
      return timeDiff <= 60 * 1000 && timeDiff > 0; // 1分钟内结束的K线
    });

    if (almostClosedKlines.length > 0) {
      console.log(`✅ 找到${almostClosedKlines.length}根即将结束的K线，使用它们`);
      return almostClosedKlines.slice(-1); // 返回最新的那根
    }

    // 如果还是没有，返回最新的K线（即使还在进行中）
    console.log('❌ 无法找到合适的K线，返回最新的K线（可能正在进行中）');
    return [klines[klines.length - 1]];
  }

  // 返回最近的已收盘K线
  return closedKlines;
}

/**
 * 确保获取的是已收盘的10分钟K线
 */
async function getClosedTenMinuteKlines() {
  // 获取K线数据（多获取一些以确保有已收盘的）
  const klines = await binanceService.getKlines('15m', 80);

  console.log(`📊 获取到${klines.length}根10分钟K线`);

  // 当前UTC时间
  const now = new Date().getTime();
  console.log(`🕐 当前时间: ${new Date(now).toLocaleString()}`);

  // 筛选已收盘的K线 - 使用closeTime字段确保准确性
  const closedKlines = klines.filter(kline => {
    // 使用K线的实际结束时间（closeTime）而不是计算值
    const endTime = kline.closeTime;
    // 结束时间小于当前时间，说明已收盘
    return endTime < now;
  });

  if (closedKlines.length === 0) {
    console.log('⚠️  没有找到已收盘的10分钟K线，尝试放宽条件...');

    // 显示最后几根K线的状态用于调试
    console.log('🔍 最后3根K线的状态:');
    for (let i = Math.max(0, klines.length - 3); i < klines.length; i++) {
      const kline = klines[i];
      const endTime = kline.closeTime;
      const isClosed = endTime < now;
      const status = isClosed ? '✅ 已收盘' : '⏳ 进行中';
      const timeDiff = isClosed ? '' : ` (${Math.floor((now - endTime) / 1000)}秒前结束)`;
      console.log(`   K线${i + 1}: ${status}, closeTime: ${new Date(endTime).toLocaleString()}${timeDiff}`);
    }

    // 如果没有找到完全已收盘的K线，找那些即将结束的K线（允许最多1分钟未完成）
    const almostClosedKlines = klines.filter(kline => {
      const endTime = kline.closeTime;
      const timeDiff = now - endTime;
      return timeDiff <= 60 * 1000 && timeDiff > 0; // 1分钟内结束的K线
    });

    if (almostClosedKlines.length > 0) {
      console.log(`✅ 找到${almostClosedKlines.length}根即将结束的K线，使用它们`);
      return almostClosedKlines.slice(-1); // 返回最新的那根
    }

    // 如果还是没有，返回最新的K线（即使还在进行中）
    console.log('❌ 无法找到合适的K线，返回最新的K线（可能正在进行中）');
    return [klines[klines.length - 1]];
  }

  // 返回最近的已收盘K线
  return closedKlines.slice(-1); // 只返回最新的已收盘K线
}

// 交易信号生成和更新
const generateTradingSignal = async () => {
  try {
    // 获取5mK线数据
    const fiveMinuteKlines = await getClosedFiveMinuteKlines();
    // 10分钟K线策略已下线
    const signal = await tradingSignalService.generateSignal('BTCUSDT', fiveMinuteKlines, []);

    if (signal) {
      io.emit('tradingSignal', signal);
      console.log(`生成交易信号: ${signal.signal} - 置信度: ${signal.confidence}%`);
    }
  } catch (error) {
    console.error('生成交易信号失败:', error);
  }
};

// 定期更新统计数据
const updateStatistics = async () => {
  try {
    // 计算今日的开始时间（北京时间0点，跨时区一致）
    const today = getBeijingTodayStart();

    const [stats, todayStats, trades, balance] = await Promise.all([
      statisticsService.calculateWinRate(),
      statisticsService.calculateWinRate({ start: today, end: new Date() }),
      statisticsService.getRecentTrades(20),
      calculateCurrentBalance()
    ]);

    // 将今日统计添加到stats中一起发送
    const statsWithToday = {
      ...stats,
      todayStats: {
        totalTrades: todayStats.totalTrades,
        winningTrades: todayStats.winningTrades,
        losingTrades: todayStats.losingTrades,
        winRate: todayStats.winRate,
        totalProfitLoss: todayStats.totalProfitLoss,
        averageConfidence: todayStats.averageConfidence
      }
    };

    io.emit('statsUpdate', statsWithToday);
    io.emit('tradesUpdate', trades);

    // 也通过balanceUpdate发送当前资金，便于客户端显示
    io.emit('balanceUpdate', {
      balance: balance,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('更新统计数据失败:', error);
  }
};

// 定期任务
setInterval(generateTradingSignal, 60000); // 每分钟生成一次信号
setInterval(updateStatistics, 10000); // 每10秒更新一次统计

// 处理交易结果更新（10分钟后）
const updateTradeResults = async () => {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const pendingTrades = await TradeModel.find({
      timestamp: { $lte: tenMinutesAgo },
      isCorrect: { $exists: false }
    });

    console.log(`检查平仓: 找到${pendingTrades.length}笔待平仓交易`);

    for (const trade of pendingTrades) {
      console.log(`处理交易 ${trade._id}: 开仓时间 ${trade.timestamp}, 当前价格 ${currentPrice}`);
      const result = await tradingSignalService.updateTradeResult(trade._id, currentPrice);
      if (result) {
        emitTradeClosed({ ...result, _id: trade._id });
      }
    }

    // 广播最近3分钟内平仓但尚未播报过的交易（覆盖其它入口进程抢先平仓的情况）
    const recentlyClosed = await TradeModel.find({
      closeTime: { $gte: new Date(Date.now() - 3 * 60 * 1000) },
      isCorrect: { $exists: true }
    }).lean();
    for (const closedTrade of recentlyClosed) {
      emitTradeClosed(closedTrade);
    }

    // 检查是否还有未平仓持仓；仅当所有持仓都已平仓时才清除当前信号
    // 不依赖本进程是否刚执行过平仓：平仓可能由其它入口进程完成，需按数据库状态判断
    const remainingOpen = await TradeModel.countDocuments({
      symbol: 'BTCUSDT',
      isCorrect: { $exists: false }
    });
    if (remainingOpen === 0) {
      io.emit('signalClear');
    }

    // 更新统计和资金
    await Promise.all([
      updateStatistics(),
      calculateCurrentBalance().then(balance => {
        io.emit('balanceUpdate', {
          balance: balance,
          timestamp: new Date().toISOString()
        });
      })
    ]);
  } catch (error) {
    console.error('更新交易结果失败:', error);
  }
};

setInterval(updateTradeResults, 60000); // 每分钟检查一次

// 定期更新并广播资金状态
setInterval(async () => {
  try {
    const balance = await calculateCurrentBalance();
    io.emit('balanceUpdate', {
      balance: balance,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('更新资金状态失败:', error);
  }
}, 5000); // 每5秒更新一次资金状态

// 前端路由 - 按优先级排序
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get('/subscription', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/subscription.html'));
});

app.get('/management', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/subscription-management.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// 所有其他路由重定向到仪表板
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`访问 http://localhost:${PORT} 查看监控面板`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    mongoose.disconnect();
  });
});

process.on('SIGINT', () => {
  console.log('收到SIGINT信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    mongoose.disconnect();
  });
});