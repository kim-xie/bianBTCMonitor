import {
  Candle,
  StrategySignal,
  calculateEma50Series
} from './registry';

export const MULTI_CROSS_ENGULF_SHORT_ID = 'multi-cross-engulf-short';
export const MULTI_CROSS_ENGULF_SHORT_NAME = '趋势策略：多次下穿反包做空';

/** 只看最近这 20 根已收盘 K 线。 */
export const LOOKBACK_BARS = 20;
/** 这 20 根里至少两次下穿 EMA50。 */
export const MIN_CROSS_COUNT = 2;
/** 收盘价低于 EMA50，且低出幅度不超过这个百分比，算下方附近。 */
export const NEAR_BELOW_PCT = 0.30;

export const MULTI_CROSS_ENGULF_SHORT_SUMMARY = [
  '最近 20 根已收盘的 5 分钟 K 线里，至少 2 次下穿 EMA50。',
  '下穿指收盘落到当根 EMA50 下方，并且开盘不低于当根 EMA50，或前一根收盘不低于前一根 EMA50。',
  '最后一次下穿之后，到反包阴线之前的 K 线都收在 EMA50 下方，距离不超过 0.30%。不要求根数。',
  '最后一根是阴线，收盘低于前一根阳线的开盘价，收盘仍在 EMA50 下方 0.30% 以内，收盘进场做空。',
  '收盘价离 EMA50 不超过 0.15% 时置信度 90，否则 85。'
].join('');

function nearBelow(close: number, ema: number): boolean {
  if (!(close < ema) || !(ema > 0)) return false;
  return ((ema - close) / ema) * 100 <= NEAR_BELOW_PCT;
}

function distancePct(close: number, ema: number): number {
  return ((ema - close) / ema) * 100;
}

/**
 * 收盘落到当根 EMA50 下方，且这根开盘在均线或均线上方，或前一根收盘在前一根 EMA50 或上方。
 */
function crossesBelowEma50(candles: Candle[], emas: Array<number | null>, index: number): boolean {
  if (index < 1) return false;
  const ema = emas[index];
  const prevEma = emas[index - 1];
  if (ema == null || prevEma == null) return false;
  const current = candles[index];
  const previous = candles[index - 1];
  return current.close < ema && (current.open >= ema || previous.close >= prevEma);
}

/** 阴线收盘低于前一根阳线的开盘价，整根阳线实体被反包。 */
function bearishBodyEngulf(current: Candle, previous: Candle): boolean {
  const previousBullish = previous.close > previous.open;
  const currentBearish = current.close < current.open;
  return previousBullish && currentBearish && current.close < previous.open;
}

export function evaluateMultiCrossEngulfShort(candles: Candle[]): StrategySignal | null {
  const lastIndex = candles.length - 1;
  if (lastIndex < 1) return null;
  const windowStart = Math.max(1, lastIndex - (LOOKBACK_BARS - 1));

  const emas = calculateEma50Series(candles.map(candle => candle.close));
  if (emas[lastIndex] == null || emas[lastIndex - 1] == null) return null;

  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  const entryEma = emas[lastIndex] as number;
  if (!bearishBodyEngulf(current, previous) || !nearBelow(current.close, entryEma)) return null;

  const crossIndexes: number[] = [];
  for (let i = windowStart; i <= lastIndex; i++) {
    if (crossesBelowEma50(candles, emas, i)) crossIndexes.push(i);
  }
  if (crossIndexes.length < MIN_CROSS_COUNT) return null;

  const crossesBeforeEntry = crossIndexes.filter(index => index < lastIndex);
  if (!crossesBeforeEntry.length) return null;
  const lastCrossBeforeEntry = crossesBeforeEntry[crossesBeforeEntry.length - 1];
  const chopCount = lastIndex - lastCrossBeforeEntry - 1;

  for (let i = lastCrossBeforeEntry + 1; i < lastIndex; i++) {
    const ema = emas[i];
    if (ema == null || !nearBelow(candles[i].close, ema)) return null;
  }

  const dist = distancePct(current.close, entryEma);
  const confidence = dist <= 0.15 ? 90 : 85;
  return {
    strategyId: MULTI_CROSS_ENGULF_SHORT_ID,
    direction: 'DOWN',
    confidence,
    reason: `${MULTI_CROSS_ENGULF_SHORT_NAME}｜20根内下穿EMA50 ${crossIndexes.length}次｜下方附近震荡${chopCount}根｜阴线反包｜距EMA50 ${dist.toFixed(2)}%｜置信度${confidence}%`
  };
}
