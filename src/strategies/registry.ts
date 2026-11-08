export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
}

export interface StrategySignal {
  strategyId: string;
  direction: 'UP' | 'DOWN';
  confidence: number;
  reason: string;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  enabled: boolean;
  summary: string;
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

/** 返回最新一根已计算 K 线的 EMA50。不足 50 根收盘价时返回 null。 */
export function calculateEma50(closes: number[]): number | null {
  if (closes.length < EMA50_PERIOD) return null;
  const k = 2 / (EMA50_PERIOD + 1);
  let prev = 0;
  for (let i = 0; i < EMA50_PERIOD; i++) prev += closes[i];
  prev /= EMA50_PERIOD;
  for (let i = EMA50_PERIOD; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * 唯一的策略定义。
 * 旧的均线反包、二次反包、连涨连跌都已下线，不在此列表中，也不会被调用。
 * enabled 为 false 时 evaluate 不会执行，因此不开仓。
 */
export const strategies: StrategyDefinition[] = [
  {
    id: 'btc-5m',
    name: 'BTC 5分钟',
    enabled: false,
    summary: [
      '品种 BTCUSDT，只看已收盘的 5 分钟 K 线。',
      '同一根 K 线最多一笔。持仓 10 分钟，每笔 100 USDT，同时最多 5 笔。',
      '10 分钟内已有同向未平仓时，不再同向开仓。',
      '趋势只看 EMA50：已收盘 5 分钟 K 线的收盘价在 EMA50 上方为多头趋势，在 EMA50 下方为空头趋势。',
      '入场规则尚未写入。当前未启用，不开仓。'
    ].join(''),
    evaluate(candles: Candle[]): StrategySignal | null {
      if (candles.length < 2) return null;
      return null;
    }
  }
];

export function listStrategyDefinitions(): Array<Pick<StrategyDefinition, 'id' | 'name' | 'enabled' | 'summary'>> {
  return strategies.map(({ id, name, enabled, summary }) => ({ id, name, enabled, summary }));
}

export function evaluateStrategies(candles: Candle[]): StrategySignal | null {
  for (const strategy of strategies) {
    if (!strategy.enabled) continue;
    const signal = strategy.evaluate(candles);
    if (signal) return signal;
  }
  return null;
}
