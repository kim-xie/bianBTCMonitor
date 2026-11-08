import {
  Candle,
  StrategySignal,
  calculateEma50Series
} from './registry';

export const MULTI_CROSS_ENGULF_LONG_ID = 'multi-cross-engulf-long';
export const MULTI_CROSS_ENGULF_LONG_NAME = '趋势策略，多次上穿反包做多';

/** 只看最近这 20 根已收盘 K 线。 */
export const LOOKBACK_BARS = 20;
/** 这 20 根里至少两次上穿 EMA50。 */
export const MIN_CROSS_COUNT = 2;
/** 最后一次上穿之后，至少这几根收在 EMA50 上方附近。 */
export const MIN_CHOP_BARS = 3;
/** 收盘价高于 EMA50，且高出幅度不超过这个百分比，算上方附近。 */
export const NEAR_ABOVE_PCT = 0.30;

export const MULTI_CROSS_ENGULF_LONG_SUMMARY = [
  '最近 20 根已收盘的 5 分钟 K 线里，至少 2 次上穿 EMA50。',
  '上穿指收盘站上当根 EMA50，并且开盘不高于当根 EMA50，或前一根收盘不高于前一根 EMA50。',
  '最后一次上穿之后，至少 3 根 K 线收在 EMA50 上方，距离不超过 0.30%。',
  '最后一根是阳线，收盘高于前一根阴线的开盘价，收盘仍在 EMA50 上方 0.30% 以内，收盘进场做多。',
  '收盘价离 EMA50 不超过 0.15% 时置信度 90，否则 85。'
].join('');

function nearAbove(close: number, ema: number): boolean {
  if (!(close > ema) || !(ema > 0)) return false;
  return ((close - ema) / ema) * 100 <= NEAR_ABOVE_PCT;
}

function distancePct(close: number, ema: number): number {
  return ((close - ema) / ema) * 100;
}

/**
 * 收盘站上当根 EMA50，且这根开盘在均线或均线下方，或前一根收盘在前一根 EMA50 或下方。
 */
function crossesAboveEma50(candles: Candle[], emas: Array<number | null>, index: number): boolean {
  if (index < 1) return false;
  const ema = emas[index];
  const prevEma = emas[index - 1];
  if (ema == null || prevEma == null) return false;
  const current = candles[index];
  const previous = candles[index - 1];
  return current.close > ema && (current.open <= ema || previous.close <= prevEma);
}

/** 阳线收盘高于前一根阴线的开盘价，整根阴线实体被反包。 */
function bullishBodyEngulf(current: Candle, previous: Candle): boolean {
  const previousBearish = previous.close < previous.open;
  const currentBullish = current.close > current.open;
  return previousBearish && currentBullish && current.close > previous.open;
}

export function evaluateMultiCrossEngulfLong(candles: Candle[]): StrategySignal | null {
  const lastIndex = candles.length - 1;
  if (lastIndex < 1) return null;
  const windowStart = Math.max(1, lastIndex - (LOOKBACK_BARS - 1));

  const emas = calculateEma50Series(candles.map(candle => candle.close));
  if (emas[lastIndex] == null || emas[lastIndex - 1] == null) return null;

  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  const entryEma = emas[lastIndex] as number;
  if (!bullishBodyEngulf(current, previous) || !nearAbove(current.close, entryEma)) return null;

  const crossIndexes: number[] = [];
  for (let i = windowStart; i <= lastIndex; i++) {
    if (crossesAboveEma50(candles, emas, i)) crossIndexes.push(i);
  }
  if (crossIndexes.length < MIN_CROSS_COUNT) return null;

  const crossesBeforeEntry = crossIndexes.filter(index => index < lastIndex);
  if (!crossesBeforeEntry.length) return null;
  const lastCrossBeforeEntry = crossesBeforeEntry[crossesBeforeEntry.length - 1];
  const chopCount = lastIndex - lastCrossBeforeEntry - 1;
  if (chopCount < MIN_CHOP_BARS) return null;

  for (let i = lastCrossBeforeEntry + 1; i < lastIndex; i++) {
    const ema = emas[i];
    if (ema == null || !nearAbove(candles[i].close, ema)) return null;
  }

  const dist = distancePct(current.close, entryEma);
  const confidence = dist <= 0.15 ? 90 : 85;
  return {
    strategyId: MULTI_CROSS_ENGULF_LONG_ID,
    direction: 'UP',
    confidence,
    reason: `${MULTI_CROSS_ENGULF_LONG_NAME}｜20根内上穿EMA50 ${crossIndexes.length}次｜上方附近震荡${chopCount}根｜阳线反包｜距EMA50 ${dist.toFixed(2)}%｜置信度${confidence}%`
  };
}
