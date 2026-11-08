import TradeModel from '../models/Trade';
import { axiosInstance } from '../utils/axiosInstance';

export interface TradingSignal {
  timestamp: Date;
  symbol: string;
  currentPrice: number;
  signal: 'BUY' | 'SELL';
  prediction: 'UP' | 'DOWN';
  confidence: number;
  reasoning: string[];
  recommendedAction: string;
  investmentAmount?: number; // 买入金额
}

export class TradingSignalService {
  private readonly FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';

  // 保留接口供仪表板定时清理；技术指标移除后不再写入新的K线占用记录
  private usedFiveMinuteKlines: Set<number> = new Set();

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
  async generateSignal(_symbol: string = 'BTCUSDT', _fiveMinuteKlines: any[] = [], _tenMinuteKlines: any[] = []): Promise<TradingSignal | null> {
    console.log('技术指标已移除，不生成交易信号');
    return null;
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