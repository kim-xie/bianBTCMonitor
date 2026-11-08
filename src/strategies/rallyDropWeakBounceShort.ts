import {
  Candle,
  StrategySignal,
  calculateEma50Series
} from './registry';

export const RALLY_DROP_WEAK_BOUNCE_SHORT_ID = 'rally-drop-weak-bounce-short';
export const RALLY_DROP_WEAK_BOUNCE_SHORT_NAME = '趋势策略：涨势下跌，弱反弹，反包做空';

/** 下跌和弱反弹都要落在最近这 20 根已收盘 K 线里。 */
export const LOOKBACK_BARS = 20;
/** 图里竖框是连续大阴线，至少 2 根。 */
export const MIN_STRONG_BARS = 2;
/** 下跌阴线的实体至少是它前面 10 根实体中位数的这么多倍。 */
export const STRONG_BODY_MULTIPLE = 2;
const BASELINE_BARS = 10;
/** 反弹 K 线的实体不超过下跌阴线平均实体的这个比例。 */
export const WEAK_BODY_RATIO = 0.5;

export const RALLY_DROP_WEAK_BOUNCE_SHORT_SUMMARY = [
  '最近 20 根已收盘的 5 分钟 K 线里，先从 EMA50 上方转入下跌，连续至少 2 根强势阴线。',
  '强势阴线指收盘低于开盘、收盘低于前一根收盘，实体至少是前面 10 根实体中位数的 2 倍。',
  '随后是一段弱反弹：每根实体不超过下跌阴线平均实体的一半，最高价不回到下跌前的高点。',
  '反弹之后出现阴线，收盘低于前一根阳线的开盘价，并且收盘落到 EMA50 下方，立即做空。',
  '反弹不超过跌幅的 30% 时置信度 90，否则 85。'
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

export function evaluateRallyDropWeakBounceShort(candles: Candle[]): StrategySignal | null {
  const lastIndex = candles.length - 1;
  if (lastIndex < MIN_STRONG_BARS + 1) return null;
  const windowStart = Math.max(0, lastIndex - (LOOKBACK_BARS - 1));

  const emas = calculateEma50Series(candles.map(candle => candle.close));
  const entryEma = emas[lastIndex];
  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  if (entryEma == null || !(current.close < entryEma)) return null;
  if (!bearishBodyEngulf(current, previous)) return null;

  for (let dropEnd = lastIndex - 2; dropEnd >= windowStart + MIN_STRONG_BARS - 1; dropEnd--) {
    const runStart = findStrongDropStart(candles, dropEnd, windowStart);
    if (runStart == null || runStart < 1) continue;

    const priorEma = emas[runStart - 1];
    if (priorEma == null || !(candles[runStart - 1].close > priorEma)) continue;

    const dropBars = candles.slice(runStart, dropEnd + 1);
    const averageDropBody = dropBars.reduce((sum, candle) => sum + body(candle), 0) / dropBars.length;
    const dropHigh = Math.max(candles[runStart - 1].high, ...dropBars.map(candle => candle.high));
    const dropLow = Math.min(...dropBars.map(candle => candle.low));
    const dropRange = dropHigh - dropLow;
    if (!(dropRange > 0) || !(averageDropBody > 0)) continue;

    const bounce = candles.slice(dropEnd + 1, lastIndex);
    if (!bounce.length) continue;
    const bounceHigh = Math.max(...bounce.map(candle => candle.high));
    if (!(bounceHigh < dropHigh)) continue;
    if (!(Math.max(...bounce.map(candle => candle.close)) > candles[dropEnd].close)) continue;
    if (!bounce.every(candle => body(candle) <= averageDropBody * WEAK_BODY_RATIO)) continue;

    const retrace = (bounceHigh - dropLow) / dropRange;
    const confidence = retrace <= 0.30 ? 90 : 85;
    return {
      strategyId: RALLY_DROP_WEAK_BOUNCE_SHORT_ID,
      direction: 'DOWN',
      confidence,
      reason: `${RALLY_DROP_WEAK_BOUNCE_SHORT_NAME}｜强势阴线${dropBars.length}根｜弱反弹${bounce.length}根｜反弹${(retrace * 100).toFixed(0)}%｜阴线反包｜置信度${confidence}%`
    };
  }

  return null;
}

function findStrongDropStart(candles: Candle[], dropEnd: number, windowStart: number): number | null {
  let start = dropEnd;
  while (start - 1 >= windowStart && start - 1 >= 1 && isFallingBear(candles, start - 1)) {
    start--;
  }
  while (dropEnd - start + 1 >= MIN_STRONG_BARS) {
    const baselineStart = Math.max(0, start - BASELINE_BARS);
    const baseline = candles.slice(baselineStart, start).map(body);
    if (baseline.length >= 1) {
      const medianBody = median(baseline);
      let allStrong = true;
      for (let index = start; index <= dropEnd; index++) {
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
