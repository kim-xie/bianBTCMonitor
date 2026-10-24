import 'dotenv/config'; // 加载.env文件配置
import mongoose from 'mongoose';
import { TradingSignalService } from './services/TradingSignal';
import { StatisticsService } from './services/StatisticsService';
import { BinanceService } from './services/BinanceService';
import PriceDataModel from './models/PriceData';
import TradeModel from './models/Trade';
import { axiosInstance } from './utils/axiosInstance';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/btc-trading';
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || ''; // 替换为实际的飞书机器人webhook地址

// 数据库连接
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000, // 增加服务器选择超时
  socketTimeoutMS: 45000, // 增加 socket 超时
  connectTimeoutMS: 30000, // 增加连接超时
  retryWrites: true,
  retryReads: true,
  maxPoolSize: 10 // 增加连接池大小
})
  .then(() => console.log('MongoDB连接成功'))
  .catch(err => console.error('MongoDB连接失败:', err));

// 服务实例
const tradingSignalService = new TradingSignalService();
const statisticsService = new StatisticsService();

// 代理配置（可选）
const proxyConfig = process.env.PROXY_HOST ? {
  host: process.env.PROXY_HOST,
  port: parseInt(process.env.PROXY_PORT || '8080'),
  auth: process.env.PROXY_USER ? {
    username: process.env.PROXY_USER,
    password: process.env.PROXY_PASS || ''
  } : undefined
} : undefined;

console.log('环境变量加载状态:');
console.log('- PROXY_HOST:', process.env.PROXY_HOST || '未设置');
console.log('- PROXY_PORT:', process.env.PROXY_PORT || '未设置');
console.log('- PROXY_USER:', process.env.PROXY_USER ? '已设置' : '未设置');
console.log('- 代理配置:', proxyConfig ? '已启用' : '未启用');

const binanceService = new BinanceService(proxyConfig);

// 获取真实BTC价格数据
const fetchBinancePriceData = async () => {
  try {
    // 首先尝试使用REST API
    const ticker = await binanceService.getCurrentPrice();
    const priceData = binanceService.convertToPriceData(ticker);

    await PriceDataModel.create(priceData);
    console.log(`已记录价格: $${priceData.price?.toFixed(2)} (24h涨跌: ${ticker.priceChangePercent}%)`);

    return priceData.price || 0;
  } catch (error: any) {
    console.error('REST API获取失败，尝试WebSocket:', error?.message || '未知错误');

    try {
      // 如果REST API失败，尝试WebSocket
      const wsPrice = await binanceService.getCurrentPriceWebSocket();
      console.log(`使用WebSocket获取价格: $${wsPrice.toFixed(2)}`);

      // 创建简化的价格数据
      const priceData = {
        symbol: 'BTCUSDT',
        timestamp: new Date(),
        price: wsPrice,
        volume: 0, // WebSocket不提供成交量
        high: wsPrice,
        low: wsPrice,
        open: wsPrice,
        close: wsPrice
      };

      await PriceDataModel.create(priceData);
      return wsPrice;
    } catch (wsError) {
      console.error('WebSocket获取也失败:', wsError);
      return currentPrice; // 返回上次的价格
    }
  }
};

// 初始化历史数据
const initializeHistoricalData = async () => {
  try {
    console.log('正在获取历史数据...');
    const historicalData = await binanceService.getHistoricalData(800);

    // 检查数据库中是否已有足够的数据
    const existingCount = await PriceDataModel.countDocuments();
    if (existingCount < 800) {
      // 清空旧数据并插入新数据
      await PriceDataModel.deleteMany({});
      await PriceDataModel.insertMany(historicalData);
      console.log(`已初始化${historicalData.length}条历史数据`);
    } else {
      console.log('数据库已有足够的历史数据');
    }
  } catch (error) {
    console.error('初始化历史数据失败:', error);
  }
};

// 获取当前价格
let currentPrice = 65000;

/**
 * 确保获取的是已收盘的5分钟K线
 */
async function getClosedFiveMinuteKlines() {
  // 获取K线数据（多获取一些以确保有已收盘的，EMA200需要至少200根）
  const klines = await binanceService.getKlines('5m', 400);

  // 当前UTC时间
  const now = new Date().getTime();

  // 筛选已收盘的K线
  const closedKlines = klines.filter(kline => {
    // K线开始时间（毫秒）
    const startTime = kline.openTime;
    // 5分钟K线的结束时间（开始时间 + 5分钟）
    const endTime = startTime + 5 * 60 * 1000;
    // 结束时间小于当前时间，说明已收盘
    return endTime < now;
  });

  if (closedKlines.length === 0) {
    throw new Error('没有找到已收盘的5分钟K线');
  }

  // 返回最近的已收盘K线
  return closedKlines;
}

// 生成交易信号
const generateTradingSignal = async () => {
  try {
    // 获取5mK线数据
    const fiveMinuteKlines = await getClosedFiveMinuteKlines();

    // 获取10分钟K线数据（从Binance API或其他数据源）
    let tenMinuteKlines: any[] = [];
    try {
      const now = Date.now();
      tenMinuteKlines = (await binanceService.getKlines('10m', 100)).filter(kline => kline.closeTime < now);
    } catch (error) {
      console.error('获取10分钟K线失败，本轮跳过10分钟分析:', error);
    }

    const signal = await tradingSignalService.generateSignal('BTCUSDT', fiveMinuteKlines, tenMinuteKlines);

    if (signal) {
      console.log(`\n=== 交易信号生成 ===`);
      console.log(`信号: ${signal.signal}`);
      console.log(`预测: ${signal.prediction}`);
      console.log(`价格: $${signal.currentPrice.toFixed(2)}`);
      console.log(`置信度: ${signal.confidence}%`);
      console.log(`推荐操作: ${signal.recommendedAction}`);
      console.log(`分析依据: ${signal.reasoning.join(', ')}`);
      console.log(`===================\n`);
    }
  } catch (error) {
    console.error('生成交易信号失败:', error);
  }
};

// 更新交易结果
const updateTradeResults = async () => {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const pendingTrades = await TradeModel.find({
      timestamp: { $lte: tenMinutesAgo },
      isCorrect: { $exists: false }
    });

    for (const trade of pendingTrades) {
      await tradingSignalService.updateTradeResult(trade._id, currentPrice);
    }
  } catch (error) {
    console.error('更新交易结果失败:', error);
  }
};

// 显示统计信息
const showStatistics = async () => {
  try {
    const stats = await statisticsService.calculateWinRate();

    console.log(`\n=== 交易统计 ===`);
    console.log(`总交易数: ${stats.totalTrades}`);
    console.log(`盈利交易: ${stats.winningTrades}`);
    console.log(`亏损交易: ${stats.losingTrades}`);
    console.log(`持仓中: ${stats.openTrades}`);
    console.log(`胜率: ${stats.winRate.toFixed(1)}%`);
    console.log(`总盈亏: $${stats.totalProfitLoss.toFixed(2)}`);
    console.log(`平均置信度: ${stats.averageConfidence.toFixed(1)}%`);
    console.log(`===============\n`);


    // await sendFeishuStatsNotification(stats);
  } catch (error) {
    console.error('获取统计信息失败:', error);
  }
};

// 清理旧数据
const cleanupOldData = async () => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await PriceDataModel.deleteMany({ timestamp: { $lt: oneDayAgo } });
    console.log('已清理24小时前的价格数据');
  } catch (error) {
    console.error('清理数据失败:', error);
  }
};

// 发送飞书统计通知
const sendFeishuStatsNotification = async () => {
  try {
    // 获取历史统计（所有时间）
    const historicalStats = await statisticsService.calculateWinRate();

    // 获取今日统计
    const today = new Date();
    today.setHours(0, 0, 0, 0); // 设置为今天0点
    const todayStats = await statisticsService.calculateWinRate({ start: today, end: new Date() });

    const formatProfitLoss = (value: number) => {
      const prefix = value >= 0 ? '+' : '';
      return `${prefix}${value.toFixed(2)}`;
    };

    const message = {
      msg_type: 'text',
      content: {
        text: `📊 交易统计报告\n\n` +
          `━━━━━━ 今日战绩 ━━━━━━\n` +
          `总交易数: ${todayStats.totalTrades}\n` +
          `盈利交易: ${todayStats.winningTrades}\n` +
          `亏损交易: ${todayStats.losingTrades}\n` +
          `持仓中: ${todayStats.openTrades}\n` +
          `胜率: ${todayStats.winRate.toFixed(1)}%\n` +
          `总盈亏: ${formatProfitLoss(todayStats.totalProfitLoss)}\n` +
          `平均置信度: ${todayStats.averageConfidence.toFixed(1)}%\n\n` +
          `━━━━━━ 历史战绩 ━━━━━━\n` +
          `总交易数: ${historicalStats.totalTrades}\n` +
          `盈利交易: ${historicalStats.winningTrades}\n` +
          `亏损交易: ${historicalStats.losingTrades}\n` +
          `持仓中: ${historicalStats.openTrades}\n` +
          `胜率: ${historicalStats.winRate.toFixed(1)}%\n` +
          `总盈亏: ${formatProfitLoss(historicalStats.totalProfitLoss)}\n` +
          `平均置信度: ${historicalStats.averageConfidence.toFixed(1)}%\n\n` +
          `发送时间: ${new Date().toLocaleString()}`
      }
    };
    console.log('飞书消息内容:', JSON.stringify(message, null, 2));
    await axiosInstance.post(FEISHU_WEBHOOK_URL, message);
    console.log('✅ 飞书统计通知发送成功');
  } catch (error) {
    console.error('发送飞书统计通知时出错:', error);
  }
};

// 每天定时发送飞书统计通知（8:30、12:00、18:00）
const scheduledTimes = [
  { hour: 8, minute: 30, key: '8:30' },
  { hour: 12, minute: 0, key: '12:00' },
  { hour: 18, minute: 0, key: '18:00' }
];
const lastSentTimes = new Set<string>(); // 记录已发送的时间点（格式：日期-时间key）

const sendScheduledNotification = () => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentDate = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

  // 清理超过1天的记录
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneDayAgoKey = `${oneDayAgo.getFullYear()}-${oneDayAgo.getMonth() + 1}-${oneDayAgo.getDate()}`;
  for (const key of lastSentTimes) {
    if (key.startsWith(oneDayAgoKey)) {
      lastSentTimes.delete(key);
    }
  }

  // 检查每个时间点
  for (const time of scheduledTimes) {
    if (currentHour === time.hour && currentMinute === time.minute) {
      const timeKey = `${currentDate}-${time.key}`;
      if (!lastSentTimes.has(timeKey)) {
        lastSentTimes.add(timeKey);
        sendFeishuStatsNotification();
        console.log(`✅ 定时飞书统计通知已发送（${time.key}）`);
      }
    }
  }
};

setInterval(sendScheduledNotification, 60000); // 每分钟检查是否需要发送

// 主循环
const main = async () => {
  console.log('BTC交易系统启动...');

  // 检查币安API连接
  const isConnected = await binanceService.checkConnection();
  if (!isConnected) {
    console.error('无法连接到币安API，请检查网络连接');
    return;
  }
  console.log('已成功连接到币安API');

  // 初始化历史数据
  await initializeHistoricalData();

  console.log('系统初始化完成，开始实时监控...');

  // 首次获取价格
  currentPrice = await fetchBinancePriceData();

  // 设置WebSocket实时价格监听
  binanceService.addPriceListener((price: number) => {
    currentPrice = price;
    console.log(`WebSocket实时价格更新: $${price.toFixed(2)}`);
  });

  // 定期任务 - 使用REST API作为备份
  setInterval(async () => {
    if (!binanceService.isWebSocketConnected()) {
      currentPrice = await fetchBinancePriceData();
    }
  }, 5000); // 每5秒获取价格数据（当WebSocket断开时）

  setInterval(generateTradingSignal, 60000); // 每分钟生成交易信号
  setInterval(updateTradeResults, 30000); // 每30秒更新交易结果
  setInterval(showStatistics, 300000 * 2); // 每10分钟显示统计
  setInterval(cleanupOldData, 3600000); // 每小时清理数据
};

// 启动系统
main().catch(console.error);

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭...');
  mongoose.disconnect();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('收到SIGINT信号，正在关闭...');
  mongoose.disconnect();
  process.exit(0);
});