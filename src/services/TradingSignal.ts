import TradeModel, { ITrade } from '../models/Trade';
import { axiosInstance } from '../utils/axiosInstance';
import { Candle, evaluateStrategies } from '../strategies/registry';

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
  private readonly CONFIDENCE_THRESHOLD = 80;
  private readonly MAX_OPEN_POSITIONS = 5;
  private readonly STAKE_USDT = 100;

  private usedFiveMinuteKlines: Set<number> = new Set();

  private markKlineAsUsed(closeTime: number): boolean {
    if (this.usedFiveMinuteKlines.has(closeTime)) return false;
    this.usedFiveMinuteKlines.add(closeTime);
    return true;
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
   * 只跑 src/strategies/registry.ts 里 enabled 的策略。没有信号就不开仓。
   */
  async generateSignal(symbol: string = 'BTCUSDT', fiveMinuteKlines: any[] = [], _tenMinuteKlines: any[] = []): Promise<TradingSignal | null> {
    try {
      this.cleanupExpiredKlines();
      if (!fiveMinuteKlines.length) return null;

      const candles = toCandles(fiveMinuteKlines);
      const found = evaluateStrategies(candles);
      if (!found) {
        console.log('没有策略信号，不开仓');
        return null;
      }
      if (found.confidence < this.CONFIDENCE_THRESHOLD) {
        console.log(`置信度 ${found.confidence}% 低于 ${this.CONFIDENCE_THRESHOLD}%，不开仓`);
        return null;
      }

      const last = candles[candles.length - 1];
      const klineCloseTime = last.closeTime || Date.now();
      if (!this.markKlineAsUsed(klineCloseTime)) {
        console.log(`5分钟K线 ${new Date(klineCloseTime).toLocaleString()} 已处理，跳过`);
        return null;
      }

      const openPositions = await TradeModel.countDocuments({
        symbol,
        isCorrect: { $exists: false }
      });
      if (openPositions >= this.MAX_OPEN_POSITIONS) {
        console.log(`持仓 ${openPositions} 笔已达上限，不开仓`);
        return null;
      }

      const targetSignal = found.direction === 'UP' ? 'BUY' : 'SELL';
      const hasRecentSameDirection = await TradeModel.findOne({
        symbol,
        signal: targetSignal,
        isCorrect: { $exists: false },
        timestamp: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
      });
      if (hasRecentSameDirection) {
        console.log(`最近 10 分钟已有同向未平仓 ${targetSignal}，跳过`);
        return null;
      }

      const currentPrice = last.close;
      const signal: TradingSignal = {
        timestamp: new Date(),
        symbol,
        currentPrice,
        signal: targetSignal,
        prediction: found.direction,
        confidence: found.confidence,
        reasoning: [found.reason],
        recommendedAction: found.direction === 'UP'
          ? `建议开仓做多 (置信度: ${found.confidence}%)`
          : `建议开仓做空 (置信度: ${found.confidence}%)`,
        investmentAmount: this.STAKE_USDT
      };

      const saved = await this.saveTrade(signal, klineCloseTime);
      if (saved) await this.sendFeishuNotification(signal, klineCloseTime);
      return signal;
    } catch (error) {
      console.error('生成交易信号时出错:', error);
      return null;
    }
  }

  private async saveTrade(signal: TradingSignal, klineCloseTime: number): Promise<boolean> {
    const tradeData: Partial<ITrade> = {
      symbol: signal.symbol,
      timestamp: signal.timestamp,
      price: signal.currentPrice,
      signal: signal.signal,
      tradeType: signal.signal === 'BUY' ? 'LONG' : 'SHORT',
      confidence: signal.confidence,
      investmentAmount: signal.investmentAmount || this.STAKE_USDT,
      prediction: signal.prediction,
      reasoning: signal.reasoning,
      klineCloseTime,
      orderSource: 'AUTO'
    };

    try {
      await TradeModel.create(tradeData);
      return true;
    } catch (error: any) {
      if (error && error.code === 11000) {
        console.log(`K线 ${new Date(klineCloseTime).toLocaleString()} 已有交易，跳过`);
        return false;
      }
      throw error;
    }
  }

  private async sendFeishuNotification(signal: TradingSignal, klineCloseTime: number): Promise<void> {
    if (!this.FEISHU_WEBHOOK_URL) return;
    try {
      await axiosInstance.post(this.FEISHU_WEBHOOK_URL, {
        msg_type: 'text',
        content: {
          text: `交易信号\n\n` +
            `方向: ${signal.prediction === 'UP' ? '上涨' : '下跌'}\n` +
            `价格: ${signal.currentPrice.toFixed(2)} USDT\n` +
            `金额: ${signal.investmentAmount} USDT\n` +
            `置信度: ${signal.confidence}%\n` +
            `K线: ${new Date(klineCloseTime).toLocaleString()}\n` +
            `${signal.reasoning.join('\n')}`
        }
      });
    } catch (error) {
      console.error('发送飞书通知时出错:', error);
    }
  }

  /**
   * 更新交易结果（严格按照10分钟持仓）。
   * 用条件更新抢占未结订单，避免两个进程在同一到期时刻各结一次。
   */
  async updateTradeResult(tradeId: string, currentPrice: number): Promise<SettleOutcome> {
    try {
      if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) {
        return { status: 'error' };
      }

      const trade = await TradeModel.findOne({ _id: tradeId, isCorrect: { $exists: false } });
      if (!trade) return { status: 'skipped' };

      // 账上的平仓时间对齐开仓后整 10 分钟，而不是轮询跑到的时刻
      const closeTime = new Date(trade.timestamp.getTime() + HOLD_DURATION_MS);
      const holdDuration = HOLD_DURATION_MS / 60000;

      const actualDirection = currentPrice > trade.price ? 'UP' : 'DOWN';
      const isCorrect = actualDirection === trade.prediction;

      // 预测正确盈利本金的 80%，预测错误亏损全部本金
      let profitLoss = 0;
      let profitLossPercent = 0;

      if (isCorrect) {
        profitLoss = trade.investmentAmount * 0.8;
        profitLossPercent = 80;
      } else {
        profitLoss = -trade.investmentAmount;
        profitLossPercent = -100;
      }

      const updated = await TradeModel.findOneAndUpdate(
        { _id: tradeId, isCorrect: { $exists: false } },
        {
          closeTime,
          closePrice: currentPrice,
          holdDuration,
          actualDirection,
          isCorrect,
          profitLoss,
          profitLossPercent
        },
        { new: true }
      );
      if (!updated) return { status: 'skipped' };

      console.log(`交易${tradeId}已平仓: ${isCorrect ? '正确' : '错误'}, ` +
        `投资金额: ${trade.investmentAmount}, ` +
        `盈亏: ${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%), ` +
        `持仓时间: ${holdDuration.toFixed(1)}分钟`);

      await this.sendFeishuCloseNotification(trade, currentPrice, closeTime, isCorrect, profitLoss, profitLossPercent, holdDuration);

      return {
        status: 'closed',
        trade: {
          _id: updated._id,
          profitLoss,
          profitLossPercent,
          isCorrect,
          tradeType: trade.tradeType,
          signal: trade.signal,
          price: trade.price,
          closePrice: currentPrice,
          closeTime,
          reasoning: trade.reasoning,
          timestamp: trade.timestamp,
          investmentAmount: trade.investmentAmount,
          orderSource: trade.orderSource,
          prediction: trade.prediction
        }
      };
    } catch (error) {
      console.error('更新交易结果时出错:', error);
      return { status: 'error' };
    }
  }

  private async sendFeishuCloseNotification(trade: any, currentPrice: number, closeTime: Date, isCorrect: boolean, profitLoss: number, profitLossPercent: number, holdDuration: number): Promise<void> {
    try {
      const sourceText = trade.orderSource === 'MANUAL' ? '👤 手动开仓' : '🤖 自动策略';
      const message = {
        msg_type: 'text',
        content: {
          text: `📊 交易平仓 (${sourceText})\n\n` +
            `订单来源: ${sourceText}\n` +
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

export const HOLD_DURATION_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ClosedTradeResult {
  _id: unknown;
  profitLoss: number;
  profitLossPercent: number;
  isCorrect: boolean;
  tradeType: 'LONG' | 'SHORT';
  signal: 'BUY' | 'SELL';
  price: number;
  closePrice: number;
  closeTime: Date;
  reasoning?: string[];
  timestamp: Date;
  investmentAmount: number;
  orderSource?: 'MANUAL' | 'AUTO';
  prediction: 'UP' | 'DOWN';
}

export type SettleOutcome =
  | { status: 'closed'; trade: ClosedTradeResult }
  | { status: 'skipped' }
  | { status: 'error' };

export function delayUntilHoldExpiry(openedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, openedAtMs + HOLD_DURATION_MS - nowMs);
}

/** 距离最早一笔未平仓到期还有多少毫秒；没有未平仓时返回 null。now 在查询之后取，避免查询耗时被算进等待。 */
export async function msUntilNextOpenExpiry(now?: number): Promise<number | null> {
  const nextOpen = await TradeModel.findOne({ isCorrect: { $exists: false } })
    .sort({ timestamp: 1 })
    .select('timestamp')
    .lean();
  if (!nextOpen?.timestamp) return null;
  return delayUntilHoldExpiry(new Date(nextOpen.timestamp).getTime(), now ?? Date.now());
}

/**
 * 把下一次结单对准最早一笔持仓的到期时刻。
 * onDue 返回的毫秒数是失败后的最少等待，避免到期检查失败时紧循环。
 */
export function createExpiryScheduler(options: {
  nextDelayMs: () => Promise<number | null>;
  onDue: () => Promise<number>;
}): { arm: (notBeforeMs?: number) => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;
  let scheduledFor = -1;

  const arm = async (notBeforeMs = 0) => {
    const current = ++token;
    let delay: number | null;
    try {
      delay = await options.nextDelayMs();
    } catch (error) {
      console.error('查询下一笔结单时间失败:', error);
      if (current !== token) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(() => {
        timer = null;
        arm(0).catch((err) => console.error('安排结单失败:', err));
      }, 2000);
      return;
    }

    if (current !== token) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (delay == null) return;

    const wait = Math.min(MAX_TIMEOUT_MS, Math.max(notBeforeMs, delay, 0));
    const fireAt = Date.now() + wait;
    if (wait >= 1000 && Math.abs(fireAt - scheduledFor) > 1000) {
      scheduledFor = fireAt;
      console.log(`下一笔持仓将在 ${Math.round(wait / 1000)} 秒后结单`);
    }

    timer = setTimeout(() => {
      timer = null;
      options.onDue()
        .then((retryMs) => arm(Math.max(0, retryMs || 0)))
        .catch((error) => {
          console.error('到期结单失败:', error);
          return arm(2000);
        });
    }, wait);
  };

  return { arm };
}

function toCandles(klines: any[]): Candle[] {
  return klines.map(kline => {
    const closeTime = kline.closeTime == null
      ? undefined
      : (typeof kline.closeTime === 'number' ? kline.closeTime : new Date(kline.closeTime).getTime());
    return {
      open: +kline.open,
      high: +kline.high,
      low: +kline.low,
      close: +kline.close,
      closeTime
    };
  });
}