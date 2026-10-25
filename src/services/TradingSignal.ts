import { TechnicalAnalysisService, PredictionResult } from './TechnicalAnalysis';
import PriceDataModel from '../models/PriceData';
import TradeModel, { ITrade } from '../models/Trade';
import { axiosInstance } from '../utils/axiosInstance';

export interface TradingSignal {
  timestamp: Date;
  symbol: string;
  currentPrice: number;
  signal: 'BUY' | 'SELL';
  prediction: 'UP' | 'DOWN';
  confidence: number;
  reasoning: string[];
  indicators: any;
  recommendedAction: string;
  investmentAmount?: number; // 买入金额
}

export class TradingSignalService {
  private technicalAnalysis: TechnicalAnalysisService;
  private readonly CONFIDENCE_THRESHOLD = 70;
  private readonly FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';

  // 防止重复使用同一根5分钟K线的全局记录
  private usedFiveMinuteKlines: Set<number> = new Set();

  constructor() {
    this.technicalAnalysis = new TechnicalAnalysisService();
  }

  /**
   * 检查并标记5分钟K线为已使用
   */
  private markKlineAsUsed(closeTime: number): boolean {
    if (this.usedFiveMinuteKlines.has(closeTime)) {
      return false; // 已经使用过
    }
    this.usedFiveMinuteKlines.add(closeTime);
    return true; // 可以生成信号
  }

  /**
   * 清理过期的K线使用记录（每小时清理一次）
   */
  public cleanupExpiredKlines(): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // 只保留最近一小时的K线记录
    this.usedFiveMinuteKlines.forEach(klineTime => {
      if (klineTime < oneHourAgo) {
        this.usedFiveMinuteKlines.delete(klineTime);
      }
    });
  }

  /**
   * 生成交易信号
   */
  async generateSignal(symbol: string = 'BTCUSDT', fiveMinuteKlines: any[], tenMinuteKlines: any[]): Promise<TradingSignal | null> {
    try {
      // 清理过期的K线记录
      this.cleanupExpiredKlines();

      // 获取最近的价格数据（至少100个数据点）
      const priceHistory = await PriceDataModel
        .find({ symbol })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean();

      if (priceHistory.length < 100) {
        console.log('价格数据不足，需要至少100个数据点');
        return null;
      }

      // 反转数组以获得正确的时间顺序
      const sortedHistory = priceHistory.reverse();
      const currentPrice = sortedHistory[sortedHistory.length - 1].close;

      // 获取最后一根5分钟K线的收盘时间作为标识
      const lastFiveKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];
      const klineCloseTime = typeof lastFiveKline.closeTime === 'number'
        ? lastFiveKline.closeTime
        : lastFiveKline.closeTime.getTime();

      console.log(`📊 K线分析: closeTime=${new Date(klineCloseTime).toLocaleString()},  closePrice=${lastFiveKline.close}`);

      // 检查这根K线是否已经使用过
      if (!this.markKlineAsUsed(klineCloseTime)) {
        console.log(`⚠️  5分钟K线 ${new Date(klineCloseTime).toLocaleString()} 已生成过信号，跳过`);
        return null;
      }

      console.log(`✅ 5分钟K线 ${new Date(klineCloseTime).toLocaleString()} 可以生成信号`)

      // 进行技术分析和预测
      const prediction = await this.technicalAnalysis.predictDirection(sortedHistory, fiveMinuteKlines);

      // 判断是否生成交易信号
      if (prediction.confidence < this.CONFIDENCE_THRESHOLD) {
        console.log(`置信度(${prediction.confidence}%)低于阈值(${this.CONFIDENCE_THRESHOLD}%)，不生成信号`);
        return null;
      }

      // 检查当前持仓数量，最多允许5笔持仓
      const openPositions = await TradeModel.countDocuments({
        symbol,
        isCorrect: { $exists: false } // 未平仓的交易
      });

      if (openPositions >= 5) {
        console.log(`当前持仓数量(${openPositions}笔)已达上限(5笔)，不允许开仓`);
        return null;
      }

      console.log(`当前持仓数量: ${openPositions}笔，可以开仓`);

      // 生成交易信号
      const signal = this.generateSignalFromPrediction(prediction, currentPrice);

      // 保存交易记录
      const saved = await this.saveTrade(signal, currentPrice, prediction, klineCloseTime);

      if (saved) {
        console.log(`✅ 成功生成并保存${signal.signal}信号，K线时间: ${klineCloseTime}`);
        // 发送飞书推送
        await this.sendFeishuNotification(signal, currentPrice, klineCloseTime);
      } else {
        console.log(`⚠️ 该K线已被其它进程开仓，跳过飞书推送，仅同步信号到界面`);
      }

      return signal;
    } catch (error) {
      console.error('生成交易信号时出错:', error);
      return null;
    }
  }

  /**
   * 根据预测结果生成交易信号
   */
  private generateSignalFromPrediction(prediction: PredictionResult, currentPrice: number): TradingSignal {
    const signal = prediction.direction === 'UP' ? 'BUY' : 'SELL';
    const recommendedAction = this.generateRecommendedAction(prediction, currentPrice);

    const investmentAmount = 10; // 固定买入金额10U

    return {
      timestamp: new Date(),
      symbol: 'BTCUSDT',
      currentPrice,
      signal,
      prediction: prediction.direction,
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
      indicators: prediction.indicators,
      recommendedAction,
      investmentAmount
    };
  }

  /**
   * 生成推荐操作
   */
  private generateRecommendedAction(prediction: PredictionResult, currentPrice: number): string {
    const { confidence, direction } = prediction;

    if (direction === 'UP') {
      if (confidence >= 85) {
        return `强烈建议开仓做多 - 高置信度(${confidence}%)看涨信号`;
      } else if (confidence >= 75) {
        return `建议开仓做多 - 中等置信度(${confidence}%)看涨信号`;
      } else {
        return `谨慎开仓做多 - 较低置信度(${confidence}%)看涨信号`;
      }
    } else {
      if (confidence >= 85) {
        return `强烈建议开仓做空 - 高置信度(${confidence}%)看跌信号`;
      } else if (confidence >= 75) {
        return `建议开仓做空 - 中等置信度(${confidence}%)看跌信号`;
      } else {
        return `谨慎开仓做空 - 较低置信度(${confidence}%)看跌信号`;
      }
    }
  }

  /**
   * 保存交易记录
   */
  private async saveTrade(signal: TradingSignal, price: number, prediction: PredictionResult, klineCloseTime: number): Promise<boolean> {
    // 根据信号确定交易类型：BUY信号对应做多(LONG)，SELL信号对应做空(SHORT)
    const tradeType = signal.signal === 'BUY' ? 'LONG' : 'SHORT';
    const investmentAmount = 10; // 固定买入金额10U

    const tradeData: Partial<ITrade> = {
      symbol: signal.symbol,
      timestamp: signal.timestamp,
      price,
      signal: signal.signal,
      tradeType, // 添加交易类型
      confidence: signal.confidence,
      investmentAmount, // 添加买入金额
      indicators: prediction.indicators,
      prediction: signal.prediction,
      reasoning: signal.reasoning, // 入场原因
      klineCloseTime // 信号所基于的5分钟K线收盘时间，用于同根K线去重
    };

    try {
      await TradeModel.create(tradeData);
      console.log(`已保存${signal.signal}交易信号，类型: ${tradeType}，价格: ${price}，投资金额: ${investmentAmount}，置信度: ${signal.confidence}%`);
      return true;
    } catch (error: any) {
      // E11000: 唯一索引冲突，说明该根5分钟K线已被（本进程重启/其它进程）交易过
      if (error && error.code === 11000) {
        console.log(`⚠️  K线 ${new Date(klineCloseTime).toLocaleString()} 已存在交易记录（唯一索引拦截），跳过重复开仓`);
        return false;
      }
      throw error;
    }
  }

  /**
   * 更新交易结果（严格按照10分钟持仓）
   */
  async updateTradeResult(tradeId: string, currentPrice: number): Promise<any> {
    try {
      const trade = await TradeModel.findById(tradeId);
      if (!trade) return null;

      // 严格按照10分钟计算平仓时间
      const closeTime = new Date(trade.timestamp.getTime() + 10 * 60 * 1000); // 10分钟后
      const holdDuration = 10; // 固定10分钟持仓时间

      // 确定实际方向
      const actualDirection = currentPrice > trade.price ? 'UP' : 'DOWN';
      const isCorrect = actualDirection === trade.prediction;

      // 基于预测正确性计算盈亏：预测正确盈利80%，预测错误亏损全部本金
      let profitLoss = 0;
      let profitLossPercent = 0;

      if (isCorrect) {
        // 预测正确：盈利买入金额的80%
        profitLoss = trade.investmentAmount * 0.8;
        profitLossPercent = 80;
      } else {
        // 预测错误：亏损全部本金
        profitLoss = -trade.investmentAmount;
        profitLossPercent = -100;
      }

      await TradeModel.findByIdAndUpdate(tradeId, {
        closeTime,
        closePrice: currentPrice,
        holdDuration,
        actualDirection,
        isCorrect,
        profitLoss,
        profitLossPercent
      });

      console.log(`交易${tradeId}已平仓: ${isCorrect ? '正确' : '错误'}, ` +
        `投资金额: ${trade.investmentAmount}, ` +
        `盈亏: ${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%), ` +
        `持仓时间: ${holdDuration.toFixed(1)}分钟`);

      // 发送飞书平仓通知
      await this.sendFeishuCloseNotification(trade, currentPrice, closeTime, isCorrect, profitLoss, profitLossPercent, holdDuration);

      return { profitLoss, isCorrect, tradeType: trade.tradeType, signal: trade.signal };
    } catch (error) {
      console.error('更新交易结果时出错:', error);
      return null;
    }
  }

  /**
   * 发送飞书通知
   */
  private async sendFeishuNotification(signal: TradingSignal, currentPrice: number, klineCloseTime: number): Promise<void> {
    try {
      const message = {
        msg_type: 'text',
        content: {
          text: `📈 交易信号\n\n` +
            `预测方向: ${signal.prediction === 'UP' ? '上涨' : '下跌'}\n` +
            `买入金额: ${signal.investmentAmount}\n` +
            `当前价格: ${currentPrice.toFixed(2)} USDT\n` +
            `置信度: ${signal.confidence}%\n` +
            `K线时间: ${new Date(klineCloseTime).toLocaleString()}\n` +
            `推荐操作: ${signal.recommendedAction}\n\n` +
            `分析依据:\n${signal.reasoning.map(reason => `- ${reason}`).join('\n')}\n\n` +
            `发送时间: ${new Date().toLocaleString()}`
        }
      };

      await axiosInstance.post(this.FEISHU_WEBHOOK_URL, message);
      console.log('✅ 飞书通知发送成功');
    } catch (error) {
      console.error('发送飞书通知时出错:', error);
    }
  }

  private async sendFeishuCloseNotification(trade: any, currentPrice: number, closeTime: Date, isCorrect: boolean, profitLoss: number, profitLossPercent: number, holdDuration: number): Promise<void> {
    try {
      const message = {
        msg_type: 'text',
        content: {
          text: `📊 交易平仓\n\n` +
            `预测结果: ${isCorrect ? '正确' : '错误'}\n` +
            `交易类型: ${trade.tradeType === 'LONG' ? '买涨' : '买跌'}\n` +
            `开仓价格: ${trade.price.toFixed(2)} USDT\n` +
            `平仓价格: ${currentPrice.toFixed(2)} USDT\n` +
            `投资金额: ${trade.investmentAmount}\n` +
            `盈亏: ${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%)\n` +
            `开仓时间: ${new Date(trade.timestamp).toLocaleString()}\n` +
            `平仓时间: ${closeTime.toLocaleString()}\n` +
            `持仓时间: ${holdDuration.toFixed(1)}分钟\n\n` +
            `发送时间: ${new Date().toLocaleString()}`
        }
      };

      await axiosInstance.post(this.FEISHU_WEBHOOK_URL, message);
      console.log('✅ 飞书平仓通知发送成功');
    } catch (error) {
      console.error('发送飞书平仓通知时出错:', error);
    }
  }
}