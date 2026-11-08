import {
  Candle,
  StrategySignal,
  calculateEma50Series
} from './registry';

export const STRONG_DROP_PULLBACK_SHORT_ID = 'strong-drop-pullback-short';
export const STRONG_DROP_PULLBACK_SHORT_NAME = '趋势策略：强势下跌，弱回调反包做空';

/** 强势下跌和弱回调都要落在最近这 20 根已收盘 K 线里。 */
export const LOOKBACK_BARS = 20;
export const MIN_STRONG_BARS = 3;
/** 强势阴线的实体至少是它前面 10 根实体中位数的这么多倍。 */
export const STRONG_BODY_MULTIPLE = 2;
const BASELINE_BARS = 10;
/** 回调 K 线的实体不超过强势阴线平均实体的这个比例。 */
export const WEAK_BODY_RATIO = 0.5;
/** 回调最高价不收回这段跌幅的一半。 */
export const MAX_RETRACE = 0.5;

export const STRONG_DROP_PULLBACK_SHORT_SUMMARY = [
  '最近 20 根已收盘的 5 分钟 K 线里，先连续出现至少 3 根强势阴线。',
  '强势阴线指收盘低于开盘、收盘低于前一根收盘，实体至少是前面 10 根实体中位数的 2 倍。',
  '随后是一段弱回调：每根实体不超过强势阴线平均实体的一半，收盘仍在 EMA50 下方，最高价不收回这段跌幅的一半。',
  '回调之后出现阴线，收盘低于前一根阳线的开盘价，并且收盘仍在 EMA50 下方，立即做空。',
  '回调不超过跌幅的 30% 时置信度 90，否则 85。'
].join('');

function body(candle: Candle): number {
  return Math.abs(candle.close - candle.open);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 阴线收盘低于前一根阳线的开盘价。 */
function bearishBodyEngulf(current: Candle, previous: Candle): boolean {
  return previous.close > previous.open
    && current.close < current.open
    && current.close < previous.open;
}

function isStrongBear(candles: Candle[], index: number, medianBody: number): boolean {
  if (index < 1) return false;
  const current = candles[index];
  const previous = candles[index - 1];
  return current.close < current.open
    && current.close < previous.close
    && body(current) > 0
    && body(current) >= medianBody * STRONG_BODY_MULTIPLE;
}

export function evaluateStrongDropPullbackShort(candles: Candle[]): StrategySignal | null {
  const lastIndex = candles.length - 1;
  if (lastIndex < MIN_STRONG_BARS + 1) return null;
  const windowStart = Math.max(0, lastIndex - (LOOKBACK_BARS - 1));

  const emas = calculateEma50Series(candles.map(candle => candle.close));
  const entryEma = emas[lastIndex];
  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  if (entryEma == null || !(current.close < entryEma)) return null;
  if (!bearishBodyEngulf(current, previous)) return null;

  for (let impulseEnd = lastIndex - 2; impulseEnd >= windowStart + MIN_STRONG_BARS - 1; impulseEnd--) {
    const runStart = findStrongRunStart(candles, impulseEnd, windowStart);
    if (runStart == null) continue;

    const strongBars = candles.slice(runStart, impulseEnd + 1);
    const averageStrongBody = strongBars.reduce((sum, candle) => sum + body(candle), 0) / strongBars.length;
    const impulseHigh = Math.max(...strongBars.map(candle => candle.high));
    const impulseLow = Math.min(...strongBars.map(candle => candle.low));
    const impulseRange = impulseHigh - impulseLow;
    if (!(impulseRange > 0) || !(averageStrongBody > 0)) continue;

    const lastStrongEma = emas[impulseEnd];
    if (lastStrongEma == null || !(candles[impulseEnd].close < lastStrongEma)) continue;

    const ceiling = impulseLow + impulseRange * MAX_RETRACE;
    const pullback = candles.slice(impulseEnd + 1, lastIndex);
    if (!pullback.length) continue;
    if (!pullback.every((candle, offset) => {
      const index = impulseEnd + 1 + offset;
      const ema = emas[index];
      return ema != null
        && candle.close < ema
        && body(candle) <= averageStrongBody * WEAK_BODY_RATIO
        && candle.high <= ceiling;
    })) continue;
    if (!(Math.max(...pullback.map(candle => candle.close)) > candles[impulseEnd].close)) continue;

    const pullbackHigh = Math.max(...pullback.map(candle => candle.high));
    const retrace = (pullbackHigh - impulseLow) / impulseRange;
    const confidence = retrace <= 0.30 ? 90 : 85;
    return {
      strategyId: STRONG_DROP_PULLBACK_SHORT_ID,
      direction: 'DOWN',
      confidence,
      reason: `${STRONG_DROP_PULLBACK_SHORT_NAME}｜强势阴线${strongBars.length}根｜弱回调${pullback.length}根｜回撤${(retrace * 100).toFixed(0)}%｜阴线反包｜置信度${confidence}%`
    };
  }

  return null;
}

function findStrongRunStart(candles: Candle[], impulseEnd: number, windowStart: number): number | null {
  let start = impulseEnd;
  while (start - 1 >= windowStart && start - 1 >= 1 && isFallingBear(candles, start - 1)) {
    start--;
  }
  while (impulseEnd - start + 1 >= MIN_STRONG_BARS) {
    const baselineStart = Math.max(0, start - BASELINE_BARS);
    const baseline = candles.slice(baselineStart, start).map(body);
    if (baseline.length >= 1) {
      const medianBody = median(baseline);
      let allStrong = true;
      for (let index = start; index <= impulseEnd; index++) {
        if (!isStrongBear(candles, index, medianBody)) {
          allStrong = false;
          break;
        }
      }
      if (allStrong) return start;
    }
    start++;
  }
  return null;
}

function isFallingBear(candles: Candle[], index: number): boolean {
  if (index < 1) return false;
  const current = candles[index];
  return current.close < current.open && current.close < candles[index - 1].close;
}
