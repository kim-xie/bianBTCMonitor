import { TechnicalAnalysisService, PredictionResult } from './TechnicalAnalysis';
import PriceDataModel from '../models/PriceData';
import TradeModel, { ITrade } from '../models/Trade';

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
}

export class TradingSignalService {
  private technicalAnalysis: TechnicalAnalysisService;
  private readonly CONFIDENCE_THRESHOLD = 70;
  private readonly TREND_STRENGTH_THRESHOLD = 0.6;

  constructor() {
    this.technicalAnalysis = new TechnicalAnalysisService();
  }

  /**
   * 生成交易信号
   */
  async generateSignal(symbol: string = 'BTCUSDT', fiveMinuteKlines: any[]): Promise<TradingSignal | null> {
    try {
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
      await this.saveTrade(signal, currentPrice, prediction);

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

    return {
      timestamp: new Date(),
      symbol: 'BTCUSDT',
      currentPrice,
      signal,
      prediction: prediction.direction,
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
      indicators: prediction.indicators,
      recommendedAction
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
  private async saveTrade(signal: TradingSignal, price: number, prediction: PredictionResult): Promise<void> {
    // 根据信号确定交易类型：BUY信号对应做多(LONG)，SELL信号对应做空(SHORT)
    const tradeType = signal.signal === 'BUY' ? 'LONG' : 'SHORT';
    const investmentAmount = 5; // 固定买入金额5U

    const tradeData: Partial<ITrade> = {
      symbol: signal.symbol,
      timestamp: signal.timestamp,
      price,
      signal: signal.signal,
      tradeType, // 添加交易类型
      confidence: signal.confidence,
      investmentAmount, // 添加买入金额
      indicators: {
        rsi: 50, // 默认值
        macd: 0, // 默认值
        ema9: prediction.indicators.ema50, // 使用ema50作为替代
        ema21: prediction.indicators.ema150, // 使用ema150作为替代
        bollinger: {
          upper: prediction.indicators.ema50 * 1.02,
          middle: prediction.indicators.ema50,
          lower: prediction.indicators.ema50 * 0.98
        }
      },
      prediction: signal.prediction,
      reasoning: signal.reasoning // 入场原因
    };

    await TradeModel.create(tradeData);
    console.log(`已保存${signal.signal}交易信号，类型: ${tradeType}，价格: ${price}，投资金额: $${investmentAmount}，置信度: ${signal.confidence}%`);
  }

  /**
   * 更新交易结果（严格按照10分钟持仓）
   */
  async updateTradeResult(tradeId: string, currentPrice: number): Promise<void> {
    try {
      const trade = await TradeModel.findById(tradeId);
      if (!trade) return;

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
        `投资金额: $${trade.investmentAmount}, ` +
        `盈亏: $${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%), ` +
        `持仓时间: ${holdDuration.toFixed(1)}分钟`);
    } catch (error) {
      console.error('更新交易结果时出错:', error);
    }
  }
}