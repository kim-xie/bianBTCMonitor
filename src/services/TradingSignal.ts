import TradeModel from '../models/Trade';
import { axiosInstance } from '../utils/axiosInstance';
import { Candle, StrategySignal, evaluateStrategies, getStrategyDefinition, strategies } from '../strategies/registry';
import { AND_3SAME_HIGHVOL_ID, AND_3SAME_PREM_ID, AND_PREM_TBR_ID, POST_HOC_MARK } from '../strategies/comboFade';

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
  strategyId?: string;
  strategyName?: string;
  /** 事后组合。官方 FAIL，只记录和通知，不下单。 */
  postHoc?: boolean;
}

export interface TradeWrite {
  symbol: string;
  timestamp: Date;
  price: number;
  signal: 'BUY' | 'SELL';
  tradeType: 'LONG' | 'SHORT';
  confidence: number;
  investmentAmount: number;
  prediction: 'UP' | 'DOWN';
  reasoning?: string[];
  klineCloseTime?: number;
  strategyId?: string;
  strategyName?: string;
  orderSource: 'AUTO';
}

/** 记录层。测试可以换掉，生产走 Mongo。 */
export interface TradeGateway {
  countOpen(symbol: string, strategyId: string): Promise<number>;
  hasRecentSameDirection(symbol: string, strategyId: string, signal: 'BUY' | 'SELL', since: Date): Promise<boolean>;
  /** 这个品种这根 K 线是否已经有任意策略的交易。有则不能再记一笔。 */
  hasTradeOnKline(symbol: string, klineCloseTime: number): Promise<boolean>;
  create(doc: TradeWrite): Promise<'ok' | 'duplicate'>;
}

/**
 * 同一根 K 线、同一方向有多条信号时，只留全样本胜率更高的一条。
 * 三条事后组合按回测胜率排在趋势策略前面：
 * and_prem_tbr 59.38%，and_3same_prem 57.28%，and_3same_highvol 56.83%。
 * 趋势策略保持 strategies 里的原顺序。数字越小越优先。
 */
const KLINE_WIN_RATE_FIRST: readonly string[] = [AND_PREM_TBR_ID, AND_3SAME_PREM_ID, AND_3SAME_HIGHVOL_ID];

export function klineTradeRank(strategyId: string): number {
  const comboRank = KLINE_WIN_RATE_FIRST.indexOf(strategyId);
  if (comboRank >= 0) return comboRank;
  const trendRank = strategies
    .filter(strategy => strategy.dataSource === 'index')
    .findIndex(strategy => strategy.id === strategyId);
  if (trendRank >= 0) return KLINE_WIN_RATE_FIRST.length + trendRank;
  return KLINE_WIN_RATE_FIRST.length + strategies.length;
}

const mongoTrades: TradeGateway = {
  async countOpen(symbol, strategyId) {
    return TradeModel.countDocuments({
      symbol,
      strategyId,
      isCorrect: { $exists: false }
    });
  },
  async hasRecentSameDirection(symbol, strategyId, signal, since) {
    const found = await TradeModel.findOne({
      symbol,
      strategyId,
      signal,
      isCorrect: { $exists: false },
      timestamp: { $gte: since }
    });
    return found != null;
  },
  async hasTradeOnKline(symbol, klineCloseTime) {
    const found = await TradeModel.findOne({ symbol, klineCloseTime });
    return found != null;
  },
  async create(doc) {
    try {
      await TradeModel.create(doc);
      return 'ok';
    } catch (error: any) {
      if (error && error.code === 11000) return 'duplicate';
      throw error;
    }
  }
};

export class TradingSignalService {
  private readonly FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';
  private readonly CONFIDENCE_THRESHOLD = 80;
  /**
   * 每条策略各自最多 5 笔未平仓。
   * 不能再按全市场一共 5 笔封顶：原有 4 条再加上 3 条事后组合，全局名额会被先触发的规则占满。
   */
  private readonly MAX_OPEN_POSITIONS = 5;
  private readonly STAKE_USDT = 100;
  private readonly trades: TradeGateway;

  private usedFiveMinuteKlines: Set<string> = new Set();
  /** 本进程已经为一根 K 线落过一笔。键是 symbol:klineCloseTime。 */
  private usedBars: Set<string> = new Set();

  constructor(trades: TradeGateway = mongoTrades) {
    this.trades = trades;
  }

  private slotKey(strategyId: string, symbol: string, closeTime: number): string {
    return `${strategyId}:${symbol}:${closeTime}`;
  }

  private markKlineAsUsed(strategyId: string, symbol: string, closeTime: number): boolean {
    const key = this.slotKey(strategyId, symbol, closeTime);
    if (this.usedFiveMinuteKlines.has(key)) return false;
    this.usedFiveMinuteKlines.add(key);
    return true;
  }

  /**
   * 清理过期的K线使用记录（每小时清理一次）
   */
  public cleanupExpiredKlines(): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // 只保留最近一小时的K线记录。键的最后一段是收盘时间。
    const dropOld = (keys: Set<string>) => {
      keys.forEach(key => {
        const closeTime = Number(key.slice(key.lastIndexOf(':') + 1));
        if (closeTime < oneHourAgo) keys.delete(key);
      });
    };
    dropOld(this.usedFiveMinuteKlines);
    dropOld(this.usedBars);
  }

  /**
   * 指数 K 线只跑四条趋势策略。spotKlines 是现货 + 溢价，只跑三条事后组合。
   * 信号各自计算，记入之前按 symbol + klineCloseTime 只留一笔。
   */
  async generateSignal(
    symbol: string = 'BTCUSDT',
    fiveMinuteKlines: any[] = [],
    _tenMinuteKlines: any[] = [],
    spotKlines: any[] = []
  ): Promise<TradingSignal[]> {
    try {
      this.cleanupExpiredKlines();
      const indexCandles = fiveMinuteKlines.length ? toCandles(fiveMinuteKlines) : [];
      const spotCandles = spotKlines.length ? toCandles(spotKlines) : [];
      if (!indexCandles.length && !spotCandles.length) return [];

      const found = [
        ...evaluateStrategies(indexCandles, 'index'),
        ...evaluateStrategies(spotCandles, 'spot')
      ];
      if (!found.length) {
        console.log('没有策略信号，不开仓');
        return [];
      }

      const capturedAt = Date.now();
      const closeTimeOf = (candles: Candle[]): number | null => {
        const last = candles[candles.length - 1];
        if (!last) return null;
        return last.closeTime || capturedAt;
      };
      const indexClose = closeTimeOf(indexCandles);
      const spotClose = closeTimeOf(spotCandles);

      interface Candidate {
        hit: StrategySignal;
        candles: Candle[];
        klineCloseTime: number;
      }
      const candidates: Candidate[] = [];
      for (const hit of found) {
        const definition = getStrategyDefinition(hit.strategyId);
        const useSpot = definition?.dataSource === 'spot';
        const candles = useSpot ? spotCandles : indexCandles;
        const klineCloseTime = useSpot ? spotClose : indexClose;
        if (klineCloseTime == null || !candles.length) continue;
        candidates.push({ hit, candles, klineCloseTime });
      }

      const byBar = new Map<number, Candidate[]>();
      for (const candidate of candidates) {
        const bucket = byBar.get(candidate.klineCloseTime);
        if (bucket) bucket.push(candidate);
        else byBar.set(candidate.klineCloseTime, [candidate]);
      }

      const saved: TradingSignal[] = [];
      for (const [klineCloseTime, bucket] of byBar) {
        const qualified: Candidate[] = [];
        for (const candidate of bucket) {
          if (candidate.hit.confidence < this.CONFIDENCE_THRESHOLD) {
            const name = getStrategyDefinition(candidate.hit.strategyId)?.name || candidate.hit.strategyId;
            console.log(`策略 ${name} 置信度 ${candidate.hit.confidence}% 低于 ${this.CONFIDENCE_THRESHOLD}%，跳过`);
            continue;
          }
          qualified.push(candidate);
        }
        if (!qualified.length) continue;

        const directions = new Set(qualified.map(candidate => candidate.hit.direction));
        if (directions.has('UP') && directions.has('DOWN')) {
          const names = qualified.map(candidate => `${candidate.hit.strategyId}:${candidate.hit.direction}`).join(', ');
          console.log(`同一根5分钟K线 ${new Date(klineCloseTime).toLocaleString()} 同时有做多和做空（${names}），整根跳过`);
          continue;
        }

        qualified.sort((left, right) => {
          const rank = klineTradeRank(left.hit.strategyId) - klineTradeRank(right.hit.strategyId);
          if (rank !== 0) return rank;
          return left.hit.strategyId.localeCompare(right.hit.strategyId);
        });

        if (this.barAlreadyUsed(symbol, klineCloseTime) || await this.trades.hasTradeOnKline(symbol, klineCloseTime)) {
          console.log(`K线 ${new Date(klineCloseTime).toLocaleString()} 已有交易，不再记录`);
          continue;
        }

        for (const candidate of qualified) {
          const recorded = await this.recordHit(symbol, candidate.hit, candidate.candles, klineCloseTime);
          if (!recorded) continue;
          const skipped = qualified.slice(qualified.indexOf(candidate) + 1);
          if (skipped.length) {
            console.log(`同一根K线保留 ${candidate.hit.strategyId}，跳过 ${skipped.map(item => item.hit.strategyId).join(', ')}`);
          }
          saved.push(recorded);
          break;
        }
      }
      return saved;
    } catch (error) {
      console.error('生成交易信号时出错:', error);
      return [];
    }
  }

  private barKey(symbol: string, closeTime: number): string {
    return `${symbol}:${closeTime}`;
  }

  private barAlreadyUsed(symbol: string, closeTime: number): boolean {
    return this.usedBars.has(this.barKey(symbol, closeTime));
  }

  private markBarAsUsed(symbol: string, closeTime: number): void {
    this.usedBars.add(this.barKey(symbol, closeTime));
  }

  private async recordHit(symbol: string, found: StrategySignal, candles: Candle[], klineCloseTime: number): Promise<TradingSignal | null> {
    const definition = getStrategyDefinition(found.strategyId);
    const postHoc = found.postHoc === true || definition?.postHoc === true;
    const strategyName = definition?.name || found.strategyId;
    if (found.confidence < this.CONFIDENCE_THRESHOLD) {
      console.log(`策略 ${strategyName} 置信度 ${found.confidence}% 低于 ${this.CONFIDENCE_THRESHOLD}%，跳过`);
      return null;
    }

    const last = candles[candles.length - 1];
    if (!last) return null;
    const targetSignal: 'BUY' | 'SELL' = found.direction === 'UP' ? 'BUY' : 'SELL';

    const openPositions = await this.trades.countOpen(symbol, found.strategyId);
    if (openPositions >= this.MAX_OPEN_POSITIONS) {
      console.log(`策略 ${strategyName} 持仓 ${openPositions} 笔已达上限，跳过`);
      return null;
    }

    const hasRecentSameDirection = await this.trades.hasRecentSameDirection(
      symbol,
      found.strategyId,
      targetSignal,
      new Date(Date.now() - 10 * 60 * 1000)
    );
    if (hasRecentSameDirection) {
      console.log(`策略 ${strategyName} 最近 10 分钟已有同向未平仓 ${targetSignal}，跳过`);
      return null;
    }

    // 名额和同向限制没过的策略不占槽。让同一根 K 线上的下一名还能记。
    if (this.barAlreadyUsed(symbol, klineCloseTime) || await this.trades.hasTradeOnKline(symbol, klineCloseTime)) {
      console.log(`K线 ${new Date(klineCloseTime).toLocaleString()} 已有交易，${strategyName} 跳过`);
      return null;
    }

    if (!this.markKlineAsUsed(found.strategyId, symbol, klineCloseTime)) {
      console.log(`策略 ${strategyName} 的5分钟K线 ${new Date(klineCloseTime).toLocaleString()} 已处理，跳过`);
      return null;
    }
    this.markBarAsUsed(symbol, klineCloseTime);

    const signal: TradingSignal = {
      timestamp: new Date(),
      symbol,
      currentPrice: last.close,
      signal: targetSignal,
      prediction: found.direction,
      confidence: found.confidence,
      reasoning: [found.reason],
      recommendedAction: postHoc
        ? `${POST_HOC_MARK}只记录，不下单 (置信度: ${found.confidence}%)`
        : (found.direction === 'UP'
          ? `建议开仓做多 (置信度: ${found.confidence}%)`
          : `建议开仓做空 (置信度: ${found.confidence}%)`),
      investmentAmount: this.STAKE_USDT,
      strategyId: found.strategyId,
      strategyName,
      postHoc
    };

    const saved = await this.saveTrade(signal, klineCloseTime);
    if (!saved) return null;
    await this.sendFeishuNotification(signal, klineCloseTime);
    return signal;
  }

  private async saveTrade(signal: TradingSignal, klineCloseTime: number): Promise<boolean> {
    const tradeData: TradeWrite = {
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
      strategyId: signal.strategyId,
      strategyName: signal.strategyName,
      orderSource: 'AUTO'
    };

    const result = await this.trades.create(tradeData);
    if (result === 'duplicate') {
      console.log(`策略 ${signal.strategyName || signal.strategyId} 在 K线 ${new Date(klineCloseTime).toLocaleString()} 已有交易，跳过`);
      return false;
    }
    return true;
  }

  private async sendFeishuNotification(signal: TradingSignal, klineCloseTime: number): Promise<void> {
    if (!this.FEISHU_WEBHOOK_URL) return;
    try {
      await axiosInstance.post(this.FEISHU_WEBHOOK_URL, {
        msg_type: 'text',
        content: {
          text: formatFeishuOpenText(signal, klineCloseTime)
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
      const definition = trade.strategyId ? getStrategyDefinition(trade.strategyId) : undefined;
      const postHoc = definition?.postHoc === true;
      const sourceText = trade.orderSource === 'MANUAL' ? '👤 手动开仓' : (postHoc ? '「事后组合 · 未通过 · 仅监控」' : '🤖 自动策略');
      const strategyLine = trade.strategyName ? `策略: ${trade.strategyName}\n` : '';
      const monitorLine = postHoc ? `状态: ${POST_HOC_MARK}\n官方: FAIL\n不下单。这不是已通过的实盘规则。\n` : '';
      const message = {
        msg_type: 'text',
        content: {
          text: `📊 交易平仓 (${sourceText})\n\n` +
            strategyLine +
            monitorLine +
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

export function formatFeishuOpenText(signal: TradingSignal, klineCloseTime: number): string {
  const lines = [
    signal.postHoc ? `交易信号 ${POST_HOC_MARK}` : '交易信号',
    ''
  ];
  if (signal.strategyName) lines.push(`策略: ${signal.strategyName}`);
  if (signal.strategyId) lines.push(`策略键: ${signal.strategyId}`);
  if (signal.postHoc) {
    lines.push(`状态: ${POST_HOC_MARK}`);
    lines.push('官方: FAIL');
    lines.push('不下单。这不是已通过的实盘规则，只监控。');
  }
  lines.push(
    `方向: ${signal.prediction === 'UP' ? '上涨' : '下跌'}`,
    `价格: ${signal.currentPrice.toFixed(2)} USDT`,
    `金额: ${signal.investmentAmount} USDT`,
    `置信度: ${signal.confidence}%`,
    `K线: ${new Date(klineCloseTime).toLocaleString()}`,
    signal.reasoning.join('\n')
  );
  return lines.join('\n');
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const number = typeof value === 'number' ? value : +String(value);
  return Number.isFinite(number) ? number : undefined;
}

function toCandles(klines: any[]): Candle[] {
  return klines.map(kline => {
    const closeTime = kline.closeTime == null
      ? undefined
      : (typeof kline.closeTime === 'number' ? kline.closeTime : new Date(kline.closeTime).getTime());
    const openTime = kline.openTime == null
      ? undefined
      : (typeof kline.openTime === 'number' ? kline.openTime : new Date(kline.openTime).getTime());
    const hasPrem = kline != null && Object.prototype.hasOwnProperty.call(kline, 'prem');
    let prem: number | null | undefined;
    if (!hasPrem) prem = undefined;
    else if (kline.prem == null || kline.prem === '') prem = null;
    else {
      const parsed = +kline.prem;
      prem = Number.isFinite(parsed) ? parsed : null;
    }
    const taker = kline.takerBuyBase != null ? kline.takerBuyBase : kline.takerBuyBaseAssetVolume;
    return {
      open: +kline.open,
      high: +kline.high,
      low: +kline.low,
      close: +kline.close,
      closeTime,
      openTime,
      volume: finiteOrUndefined(kline.volume),
      takerBuyBase: finiteOrUndefined(taker),
      prem
    };
  });
}