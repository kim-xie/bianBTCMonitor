import type { Candle, StrategySignal } from './registry';

/**
 * 事后组合。官方回测状态是 FAIL。
 * 只监控、只记入 Mongo、只发飞书。不是已通过的实盘规则，禁止向币安下单。
 * 阈值和公式锁定，对齐 new-strategies / batch3 / combo-vol 的 backtest.py，以及
 * win_pattern_extract.py 里「同一根 K 线、方向相同才 AND」的做法。不得改阈值。
 */
export const POST_HOC_MARK = '「事后组合 · 未通过 · 仅监控」';

export const AND_PREM_TBR_ID = 'and_prem_tbr';
export const AND_PREM_TBR_NAME = '溢价逆势 ∩ 主动买比极端逆势';

export const AND_3SAME_PREM_ID = 'and_3same_prem';
export const AND_3SAME_PREM_NAME = '连涨 3 根逆势 ∩ 溢价逆势';

export const AND_3SAME_HIGHVOL_ID = 'and_3same_highvol';
export const AND_3SAME_HIGHVOL_NAME = '连涨 3 根逆势 ∩ 高波动 ATR 逆势';

export const POST_HOC_STRATEGY_IDS = [
  AND_PREM_TBR_ID,
  AND_3SAME_PREM_ID,
  AND_3SAME_HIGHVOL_ID
] as const;

/** 前 300 根（下标 0..299）不出信号。与 batch3 的 WARMUP=300 一致。 */
export const COMBO_WARMUP_BARS = 300;
/** Wilder ATR 周期。ewm(alpha=1/14, adjust=False)。 */
export const ATR_PERIOD = 14;
export const ATR_ALPHA = 1 / ATR_PERIOD;
/** (close-open)/ATR14 的逆势阈值。 */
export const ATR_FADE_THRESHOLD = 1.5;
/** 高波动比较的是前 200 根（不含当前）ATR14/close 的中位数。 */
export const HIGHVOL_LOOKBACK = 200;
/** |close_i-close_{i-3}|/ATR14 的连涨连跌阈值。 */
export const FADE_3SAME_ATR = 1.5;
/** 现货主动买比。volume=0 或缺失则无信号。 */
export const TBR_HIGH = 0.70;
export const TBR_LOW = 0.30;
/** 溢价 z 用前 288 根（不含当前）的均值和样本标准差。 */
export const PREM_Z_WINDOW = 288;
export const PREM_Z_THRESHOLD = 3;
export const FIVE_MIN_MS = 5 * 60 * 1000;
export const COMBO_CONFIDENCE = 85;

const FAIL_NOTE = `${POST_HOC_MARK}官方状态 FAIL。这是看完结果之后拼出来的组合，不是已通过的实盘规则。只在已收盘的 5 分钟 K 线上记录和通知，10 分钟后按 +0.8 / -1.0 R 结算。不下单，不向币安发送任何订单。`;

export const AND_PREM_TBR_SUMMARY = [
  FAIL_NOTE,
  '同一根已收盘 5 分钟 K 线里，prem_z_fade 和 tbr_extreme_fade 都触发，而且方向相同。',
  '溢价 z：USDT-M 溢价指数 5 分钟收盘，减去前 288 根均值，再除以前 288 根样本标准差（都不含当前）。z≥3 做空，z≤-3 做多。缺 bar 或标准差为 0 则无信号。',
  '主动买比：现货 taker_buy_base / volume。≥0.70 做空，≤0.30 做多。volume 为 0 或缺失则无信号。',
  '方向相反、或只有一边触发，都不出这个组合。前 300 根不出信号。',
  '回测全样本 N=480，胜率 59.38%，期望 +0.069R；样本外 N=198（不足 200），胜率 61.62%。'
].join('');

export const AND_3SAME_PREM_SUMMARY = [
  FAIL_NOTE,
  '同一根已收盘 5 分钟 K 线里，fade_3same 和 prem_z_fade 都触发，而且方向相同。',
  '连涨 3 根：close_i>close_{i-1}>close_{i-2}>close_{i-3}，或连续 3 根收盘下跌，并且 |close_i-close_{i-3}|/ATR14≥1.5，逆这 3 根的方向。',
  '溢价 z 的定义和 prem_z_fade 相同：前 288 根，z≥3 做空，z≤-3 做多。',
  '前 300 根不出信号。回测全样本 N=419，胜率 57.28%；样本外 N=117，胜率 53.85%。'
].join('');

export const AND_3SAME_HIGHVOL_SUMMARY = [
  FAIL_NOTE,
  '同一根已收盘 5 分钟 K 线里，fade_3same 和 fade_atr15_highvol 都触发，而且方向相同。',
  '高波动 ATR 逆势：先要求 ATR14/close 大于前 200 根（不含当前）ATR14/close 的中位数，再套 fade_atr15。(close-open)/ATR14≥1.5 做空，≤-1.5 做多。',
  'ATR14 是 Wilder：第一根 TR=high-low，之后 ewm(alpha=1/14, adjust=False)。前 300 根不出信号。',
  '回测全样本 N=1626，胜率 56.83%；样本外 N=533，胜率 57.79%。'
].join('');

export function monitorLabel(chineseName: string): string {
  return `${POST_HOC_MARK}${chineseName}`;
}

/** +1 做多，-1 做空，0 无信号。和回测脚本的符号一致。 */
export type SignedDirection = -1 | 0 | 1;

/**
 * 有 openTime 时，要求 [index-lookback, index] 每相邻两根都正好隔 5 分钟。
 * 缺一根就不会把两边粘成连续样本。测试数据没带 openTime 时视为已经对齐的连续序列。
 */
export function priorWindowContiguous(candles: Candle[], index: number, lookback: number): boolean {
  if (lookback < 0 || index < lookback) return false;
  let sawTime = false;
  let sawMissing = false;
  for (let i = index - lookback; i <= index; i++) {
    const open = candles[i]?.openTime;
    if (open == null || !Number.isFinite(open)) sawMissing = true;
    else sawTime = true;
  }
  if (!sawTime) return true;
  if (sawMissing) return false;
  for (let i = index - lookback + 1; i <= index; i++) {
    if ((candles[i].openTime as number) - (candles[i - 1].openTime as number) !== FIVE_MIN_MS) return false;
  }
  return true;
}

/** 从序列起点到信号根都要连续，避免跨缺口做 ATR。 */
export function seriesContiguous(candles: Candle[], index: number): boolean {
  if (index < 0) return false;
  return priorWindowContiguous(candles, index, index);
}

/**
 * Wilder ATR14。
 * tr = max(high-low, |high-prevClose|, |low-prevClose|)；第一根 tr = high-low。
 * 之后 atr = (1-1/14)*prev + (1/14)*tr，对应 pandas ewm(alpha=1/14, adjust=False)。
 */
export function wilderAtr14(candles: Candle[]): number[] {
  const atr = new Array<number>(candles.length);
  if (!candles.length) return atr;
  let prev = candles[0].high - candles[0].low;
  atr[0] = prev;
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    prev = (1 - ATR_ALPHA) * prev + ATR_ALPHA * tr;
    atr[i] = prev;
  }
  return atr;
}

/** 偶数个样本取中间两个的平均，和 pandas / numpy 的 median 一致。 */
export function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function fadeAtr15(candles: Candle[], index: number, atr: number[]): SignedDirection {
  if (index < 0 || index >= candles.length) return 0;
  if (!seriesContiguous(candles, index)) return 0;
  const scale = atr[index];
  if (!Number.isFinite(scale) || !(scale > 0)) return 0;
  const body = (candles[index].close - candles[index].open) / scale;
  if (body >= ATR_FADE_THRESHOLD) return -1;
  if (body <= -ATR_FADE_THRESHOLD) return 1;
  return 0;
}

export function fadeAtr15Highvol(candles: Candle[], index: number, atr: number[]): SignedDirection {
  const base = fadeAtr15(candles, index, atr);
  if (base === 0) return 0;
  if (!priorWindowContiguous(candles, index, HIGHVOL_LOOKBACK)) return 0;
  const close = candles[index].close;
  const scale = atr[index];
  if (!(close > 0) || !Number.isFinite(scale)) return 0;
  const window: number[] = [];
  for (let i = index - HIGHVOL_LOOKBACK; i < index; i++) {
    const barClose = candles[i].close;
    const barAtr = atr[i];
    if (!(barClose > 0) || !Number.isFinite(barAtr)) return 0;
    window.push(barAtr / barClose);
  }
  const med = median(window);
  if (!Number.isFinite(med)) return 0;
  if (!((scale / close) > med)) return 0;
  return base;
}

export function fade3Same(candles: Candle[], index: number, atr: number[]): SignedDirection {
  if (index < 3) return 0;
  if (!priorWindowContiguous(candles, index, 3)) return 0;
  if (!seriesContiguous(candles, index)) return 0;
  const scale = atr[index];
  if (!Number.isFinite(scale) || !(scale > 0)) return 0;
  const close0 = candles[index].close;
  const close1 = candles[index - 1].close;
  const close2 = candles[index - 2].close;
  const close3 = candles[index - 3].close;
  if (!(Math.abs(close0 - close3) / scale >= FADE_3SAME_ATR)) return 0;
  if (close0 > close1 && close1 > close2 && close2 > close3) return -1;
  if (close0 < close1 && close1 < close2 && close2 < close3) return 1;
  return 0;
}

export function tbrExtremeFade(candles: Candle[], index: number): SignedDirection {
  if (index < 0 || index >= candles.length) return 0;
  const volume = candles[index].volume;
  const taker = candles[index].takerBuyBase;
  if (volume == null || taker == null) return 0;
  if (!Number.isFinite(volume) || !Number.isFinite(taker) || volume === 0) return 0;
  const tbr = taker / volume;
  if (tbr >= TBR_HIGH) return -1;
  if (tbr <= TBR_LOW) return 1;
  return 0;
}

export function premZFade(candles: Candle[], index: number): SignedDirection {
  if (!priorWindowContiguous(candles, index, PREM_Z_WINDOW)) return 0;
  const current = candles[index].prem;
  if (current == null || !Number.isFinite(current)) return 0;
  let sum = 0;
  for (let i = index - PREM_Z_WINDOW; i < index; i++) {
    const value = candles[i].prem;
    if (value == null || !Number.isFinite(value)) return 0;
    sum += value;
  }
  const mean = sum / PREM_Z_WINDOW;
  let square = 0;
  for (let i = index - PREM_Z_WINDOW; i < index; i++) {
    const delta = (candles[i].prem as number) - mean;
    square += delta * delta;
  }
  const std = Math.sqrt(square / (PREM_Z_WINDOW - 1));
  if (!Number.isFinite(std) || std === 0) return 0;
  const z = (current - mean) / std;
  if (z >= PREM_Z_THRESHOLD) return -1;
  if (z <= -PREM_Z_THRESHOLD) return 1;
  return 0;
}

function combine(
  candles: Candle[],
  strategyId: string,
  chineseName: string,
  partsLabel: string,
  read: (candles: Candle[], index: number, atr: number[]) => SignedDirection[]
): StrategySignal | null {
  const index = candles.length - 1;
  if (index < COMBO_WARMUP_BARS) return null;
  const atr = wilderAtr14(candles);
  const directions = read(candles, index, atr);
  const direction = directions[0];
  if (direction !== 1 && direction !== -1) return null;
  if (directions.some(item => item !== direction)) return null;
  const side = direction === 1 ? '做多' : '做空';
  return {
    strategyId,
    direction: direction === 1 ? 'UP' : 'DOWN',
    confidence: COMBO_CONFIDENCE,
    postHoc: true,
    reason: `${monitorLabel(chineseName)}｜${partsLabel}同向${side}｜官方FAIL｜不下单｜仅监控`
  };
}

export function evaluateAndPremTbr(candles: Candle[]): StrategySignal | null {
  return combine(candles, AND_PREM_TBR_ID, AND_PREM_TBR_NAME, 'prem_z_fade ∩ tbr_extreme_fade', (bars, index) => [
    premZFade(bars, index),
    tbrExtremeFade(bars, index)
  ]);
}

export function evaluateAnd3SamePrem(candles: Candle[]): StrategySignal | null {
  return combine(candles, AND_3SAME_PREM_ID, AND_3SAME_PREM_NAME, 'fade_3same ∩ prem_z_fade', (bars, index, atr) => [
    fade3Same(bars, index, atr),
    premZFade(bars, index)
  ]);
}

export function evaluateAnd3SameHighvol(candles: Candle[]): StrategySignal | null {
  return combine(candles, AND_3SAME_HIGHVOL_ID, AND_3SAME_HIGHVOL_NAME, 'fade_3same ∩ fade_atr15_highvol', (bars, index, atr) => [
    fade3Same(bars, index, atr),
    fadeAtr15Highvol(bars, index, atr)
  ]);
}
