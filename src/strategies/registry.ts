import { evaluateMultiCrossEngulfLong, MULTI_CROSS_ENGULF_LONG_ID, MULTI_CROSS_ENGULF_LONG_NAME, MULTI_CROSS_ENGULF_LONG_SUMMARY } from './multiCrossEngulfLong';
import { evaluateMultiCrossEngulfShort, MULTI_CROSS_ENGULF_SHORT_ID, MULTI_CROSS_ENGULF_SHORT_NAME, MULTI_CROSS_ENGULF_SHORT_SUMMARY } from './multiCrossEngulfShort';
import { evaluateStrongRallyPullbackLong, STRONG_RALLY_PULLBACK_LONG_ID, STRONG_RALLY_PULLBACK_LONG_NAME, STRONG_RALLY_PULLBACK_LONG_SUMMARY } from './strongRallyPullbackLong';
import { evaluateStrongDropPullbackShort, STRONG_DROP_PULLBACK_SHORT_ID, STRONG_DROP_PULLBACK_SHORT_NAME, STRONG_DROP_PULLBACK_SHORT_SUMMARY } from './strongDropPullbackShort';
import {
  AND_3SAME_HIGHVOL_ID,
  AND_3SAME_HIGHVOL_NAME,
  AND_3SAME_HIGHVOL_SUMMARY,
  AND_3SAME_PREM_ID,
  AND_3SAME_PREM_NAME,
  AND_3SAME_PREM_SUMMARY,
  AND_PREM_TBR_ID,
  AND_PREM_TBR_NAME,
  AND_PREM_TBR_SUMMARY,
  evaluateAnd3SameHighvol,
  evaluateAnd3SamePrem,
  evaluateAndPremTbr,
  monitorLabel
} from './comboFade';

export type StrategyDataSource = 'index' | 'spot';

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
  openTime?: number;
  /** 成交量。指数价格 K 线通常没有真实成交量，趋势策略不读这个字段。 */
  volume?: number;
  /** 主动买入量 taker_buy_base。指数价格 K 线通常没有这一项。 */
  takerBuyBase?: number;
  /** 溢价指数 5 分钟收盘，按 openTime 对齐到指数价格 K 线。null 表示这根没有对齐到溢价。 */
  prem?: number | null;
}

export interface StrategySignal {
  strategyId: string;
  direction: 'UP' | 'DOWN';
  confidence: number;
  reason: string;
  /** 事后组合。官方 FAIL，只监控，不下单。 */
  postHoc?: boolean;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  enabled: boolean;
  summary: string;
  /** 价格 K 线来源。当前每条策略都是 index：事件合约指数价格 K 线。 */
  dataSource: StrategyDataSource;
  postHoc?: boolean;
  officialStatus?: 'FAIL';
  evaluate(candles: Candle[]): StrategySignal | null;
}

/** 图表和趋势判断使用同一条 EMA50：周期 50，平滑系数 2/51。 */
export const EMA50_PERIOD = 50;

export type MarketTrend = '多头趋势' | '空头趋势';

/**
 * 趋势的唯一定义。以后提到多头趋势、空头趋势，只按这里判断。
 * 已收盘 K 线的收盘价高于 EMA50，是多头趋势。
 * 已收盘 K 线的收盘价低于 EMA50，是空头趋势。
 * 收盘价等于 EMA50 时，既不是多头趋势，也不是空头趋势。
 * 这只定义趋势，不是开仓条件。
 */
export function classifyEma50Trend(close: number, ema50: number): MarketTrend | null {
  if (!Number.isFinite(close) || !Number.isFinite(ema50)) return null;
  if (close > ema50) return '多头趋势';
  if (close < ema50) return '空头趋势';
  return null;
}

/** 每根 K 线对应的 EMA50。前 49 根没有值。 */
export function calculateEma50Series(closes: number[]): Array<number | null> {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length < EMA50_PERIOD) return out;
  const k = 2 / (EMA50_PERIOD + 1);
  let prev = 0;
  for (let i = 0; i < EMA50_PERIOD; i++) prev += closes[i];
  prev /= EMA50_PERIOD;
  out[EMA50_PERIOD - 1] = prev;
  for (let i = EMA50_PERIOD; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 返回最新一根已计算 K 线的 EMA50。不足 50 根收盘价时返回 null。 */
export function calculateEma50(closes: number[]): number | null {
  const series = calculateEma50Series(closes);
  const last = series[series.length - 1];
  return last == null ? null : last;
}

/**
 * 策略定义。
 * 旧的均线反包、二次反包、连涨连跌都已下线，不在此列表中，也不会被调用。
 * 七条策略的价格都用事件合约指数 K 线。开仓条件没有改。
 * 后三条是事后组合，官方 FAIL，只监控。溢价仍按 openTime 对齐到指数 K 线。enabled 为 false 时 evaluate 不会执行。
 */
export const strategies: StrategyDefinition[] = [
  {
    id: MULTI_CROSS_ENGULF_LONG_ID,
    name: MULTI_CROSS_ENGULF_LONG_NAME,
    enabled: true,
    summary: MULTI_CROSS_ENGULF_LONG_SUMMARY,
    dataSource: 'index',
    evaluate: evaluateMultiCrossEngulfLong
  },
  {
    id: MULTI_CROSS_ENGULF_SHORT_ID,
    name: MULTI_CROSS_ENGULF_SHORT_NAME,
    enabled: true,
    summary: MULTI_CROSS_ENGULF_SHORT_SUMMARY,
    dataSource: 'index',
    evaluate: evaluateMultiCrossEngulfShort
  },
  {
    id: STRONG_RALLY_PULLBACK_LONG_ID,
    name: STRONG_RALLY_PULLBACK_LONG_NAME,
    enabled: true,
    summary: STRONG_RALLY_PULLBACK_LONG_SUMMARY,
    dataSource: 'index',
    evaluate: evaluateStrongRallyPullbackLong
  },
  {
    id: STRONG_DROP_PULLBACK_SHORT_ID,
    name: STRONG_DROP_PULLBACK_SHORT_NAME,
    enabled: true,
    summary: STRONG_DROP_PULLBACK_SHORT_SUMMARY,
    dataSource: 'index',
    evaluate: evaluateStrongDropPullbackShort
  },
  {
    id: AND_PREM_TBR_ID,
    name: monitorLabel(AND_PREM_TBR_NAME),
    enabled: true,
    summary: AND_PREM_TBR_SUMMARY,
    dataSource: 'index',
    postHoc: true,
    officialStatus: 'FAIL',
    evaluate: evaluateAndPremTbr
  },
  {
    id: AND_3SAME_PREM_ID,
    name: monitorLabel(AND_3SAME_PREM_NAME),
    enabled: true,
    summary: AND_3SAME_PREM_SUMMARY,
    dataSource: 'index',
    postHoc: true,
    officialStatus: 'FAIL',
    evaluate: evaluateAnd3SamePrem
  },
  {
    id: AND_3SAME_HIGHVOL_ID,
    name: monitorLabel(AND_3SAME_HIGHVOL_NAME),
    enabled: true,
    summary: AND_3SAME_HIGHVOL_SUMMARY,
    dataSource: 'index',
    postHoc: true,
    officialStatus: 'FAIL',
    evaluate: evaluateAnd3SameHighvol
  }
];

export function getStrategyDefinition(id: string): StrategyDefinition | undefined {
  return strategies.find(strategy => strategy.id === id);
}

export function listStrategyDefinitions(): Array<Pick<StrategyDefinition, 'id' | 'name' | 'enabled' | 'summary' | 'dataSource' | 'postHoc' | 'officialStatus'>> {
  return strategies.map(({ id, name, enabled, summary, dataSource, postHoc, officialStatus }) => ({
    id,
    name,
    enabled,
    summary,
    dataSource,
    postHoc: postHoc === true,
    officialStatus
  }));
}

/**
 * 每条启用的策略单独判断。同一根 K 线可以同时走出多条信号。
 * 不传 dataSource 时跑全部指数策略，包括事后组合。
 */
export function evaluateStrategies(candles: Candle[], dataSource: StrategyDataSource = 'index'): StrategySignal[] {
  if (!candles.length) return [];
  const signals: StrategySignal[] = [];
  for (const strategy of strategies) {
    if (!strategy.enabled || strategy.dataSource !== dataSource) continue;
    const signal = strategy.evaluate(candles);
    if (signal) signals.push(signal);
  }
  return signals;
}
