/**
 * 事后组合验收。跑法：
 * npm run test:combos
 * 这些规则官方 FAIL，只监控。测试确认它们不会被当成已通过的下单规则。
 */
import assert from 'assert';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { BinanceService } from '../services/BinanceService';
import { alignClosedSpotAndPremium, settlementPriceForTrade, SPOT_COMBO_FETCH_LIMIT } from '../services/spotComboFeed';
import { HOLD_DURATION_MS, TradingSignalService, formatFeishuOpenText, TradeGateway, TradeWrite, klineTradeRank } from '../services/TradingSignal';
import TradeModel, { isLegacyKlineUniqueIndex } from '../models/Trade';
import {
  evaluateStrategies,
  getStrategyDefinition,
  listStrategyDefinitions,
  strategies,
  Candle
} from '../strategies/registry';
import { evaluateMultiCrossEngulfLong, LOOKBACK_BARS as LONG_LOOKBACK, MIN_CROSS_COUNT as LONG_CROSSES, NEAR_ABOVE_PCT } from '../strategies/multiCrossEngulfLong';
import { evaluateMultiCrossEngulfShort, LOOKBACK_BARS as SHORT_LOOKBACK, MIN_CROSS_COUNT as SHORT_CROSSES, NEAR_BELOW_PCT } from '../strategies/multiCrossEngulfShort';
import { evaluateStrongRallyPullbackLong, LOOKBACK_BARS as RALLY_LOOKBACK, MIN_STRONG_BARS as RALLY_BARS, STRONG_BODY_MULTIPLE as RALLY_MULTIPLE, WEAK_BODY_RATIO as RALLY_WEAK, MAX_RETRACE as RALLY_RETRACE } from '../strategies/strongRallyPullbackLong';
import { evaluateStrongDropPullbackShort, LOOKBACK_BARS as DROP_LOOKBACK, MIN_STRONG_BARS as DROP_BARS, STRONG_BODY_MULTIPLE as DROP_MULTIPLE, WEAK_BODY_RATIO as DROP_WEAK, MAX_RETRACE as DROP_RETRACE } from '../strategies/strongDropPullbackShort';
import {
  AND_3SAME_HIGHVOL_ID,
  AND_3SAME_HIGHVOL_NAME,
  AND_3SAME_PREM_ID,
  AND_3SAME_PREM_NAME,
  AND_PREM_TBR_ID,
  AND_PREM_TBR_NAME,
  ATR_FADE_THRESHOLD,
  ATR_PERIOD,
  COMBO_WARMUP_BARS,
  FADE_3SAME_ATR,
  FIVE_MIN_MS,
  HIGHVOL_LOOKBACK,
  POST_HOC_MARK,
  PREM_Z_THRESHOLD,
  PREM_Z_WINDOW,
  TBR_HIGH,
  TBR_LOW,
  evaluateAnd3SameHighvol,
  evaluateAnd3SamePrem,
  evaluateAndPremTbr,
  fade3Same,
  fadeAtr15,
  fadeAtr15Highvol,
  median,
  monitorLabel,
  premZFade,
  tbrExtremeFade,
  wilderAtr14,
  SignedDirection
} from '../strategies/comboFade';

const START = Date.now() - 301 * FIVE_MIN_MS;

class MemoryTrades implements TradeGateway {
  docs: TradeWrite[] = [];
  async countOpen(symbol: string, strategyId: string): Promise<number> {
    return this.docs.filter(doc => doc.symbol === symbol && doc.strategyId === strategyId).length;
  }
  async hasRecentSameDirection(symbol: string, strategyId: string, signal: 'BUY' | 'SELL', since: Date): Promise<boolean> {
    return this.docs.some(doc => doc.symbol === symbol && doc.strategyId === strategyId && doc.signal === signal && doc.timestamp >= since);
  }
  async hasTradeOnKline(symbol: string, klineCloseTime: number): Promise<boolean> {
    return this.docs.some(doc => doc.symbol === symbol && doc.klineCloseTime === klineCloseTime);
  }
  async create(doc: TradeWrite): Promise<'ok' | 'duplicate'> {
    const duplicate = this.docs.some(existing => existing.symbol === doc.symbol && existing.strategyId === doc.strategyId && existing.klineCloseTime === doc.klineCloseTime);
    if (duplicate) return 'duplicate';
    this.docs.push(doc);
    return 'ok';
  }
}

function bar(index: number, patch: Partial<Candle> = {}): Candle {
  return {
    openTime: START + index * FIVE_MIN_MS,
    closeTime: START + (index + 1) * FIVE_MIN_MS - 1,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 100,
    takerBuyBase: 50,
    prem: index % 2 === 0 ? 1 : -1,
    ...patch
  };
}

function series(count: number, patchIndex?: (index: number, candle: Candle) => void): Candle[] {
  const candles = Array.from({ length: count }, (_, index) => bar(index));
  if (patchIndex) {
    candles.forEach((candle, index) => patchIndex(index, candle));
  }
  return candles;
}

function clone(candles: Candle[]): Candle[] {
  return candles.map(candle => ({ ...candle }));
}

function shiftTimes(candles: Candle[], delta: number): Candle[] {
  return candles.map(candle => ({
    ...candle,
    openTime: candle.openTime == null ? undefined : candle.openTime + delta,
    closeTime: candle.closeTime == null ? undefined : candle.closeTime + delta
  }));
}

function alignClose(candles: Candle[], closeTime: number): Candle[] {
  const next = clone(candles);
  next[next.length - 1].closeTime = closeTime;
  return next;
}

function paint(candles: Candle[], index: number, open: number, high: number, low: number, close: number): void {
  Object.assign(candles[index], { open, high, low, close });
}

function flatIndex(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * FIVE_MIN_MS,
    closeTime: (index + 1) * FIVE_MIN_MS - 1,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100
  }));
}

/** 70 根里最后几根走出多次下穿反包做空。只动价格，不改组合公式。 */
function engulfShortIndex(): Candle[] {
  const candles = flatIndex(70);
  const last = candles.length - 1;
  paint(candles, last - 3, 100, 100.2, 99.7, 99.8);
  paint(candles, last - 2, 100, 100.2, 99.8, 99.9);
  paint(candles, last - 1, 99.9, 100, 99.85, 99.95);
  paint(candles, last, 99.96, 100, 99.8, 99.89);
  return candles;
}

/** 70 根里最后几根走出多次上穿反包做多。 */
function engulfLongIndex(): Candle[] {
  const candles = flatIndex(70);
  const last = candles.length - 1;
  paint(candles, last - 3, 100, 100.3, 99.8, 100.2);
  paint(candles, last - 2, 100, 100.2, 99.8, 100.1);
  paint(candles, last - 1, 100.1, 100.15, 99.9, 100.05);
  paint(candles, last, 100.04, 100.2, 100, 100.11);
  return candles;
}

function fallingOpposite(candles: Candle[]): Candle[] {
  const next = clone(candles);
  const last = next.length - 1;
  Object.assign(next[last - 2], { open: 100, high: 100, low: 98, close: 99 });
  Object.assign(next[last - 1], { open: 99, high: 99, low: 96, close: 97 });
  Object.assign(next[last], { open: 97, high: 97, low: 60, close: 70 });
  return next;
}

function paperTrade(patch: Partial<TradeWrite> & Pick<TradeWrite, 'strategyId' | 'klineCloseTime'>): TradeWrite {
  return {
    symbol: 'BTCUSDT',
    timestamp: new Date(),
    price: 1,
    signal: 'SELL',
    tradeType: 'SHORT',
    confidence: 85,
    investmentAmount: 100,
    prediction: 'DOWN',
    strategyName: patch.strategyId,
    orderSource: 'AUTO',
    ...patch
  };
}

function sampleStd(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const square = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(square / (values.length - 1));
}

function priorPrem(candles: Candle[], index: number): number[] {
  return candles.slice(index - PREM_Z_WINDOW, index).map(candle => candle.prem as number);
}

function armPremAndTbr(candles: Candle[], prem: number, takerBuyBase: number, volume = 100): Candle[] {
  const next = clone(candles);
  const last = next[next.length - 1];
  last.prem = prem;
  last.takerBuyBase = takerBuyBase;
  last.volume = volume;
  return next;
}

function risingFade(candles: Candle[]): Candle[] {
  const next = clone(candles);
  const last = next.length - 1;
  Object.assign(next[last - 2], { open: 100, high: 101, low: 100, close: 101 });
  Object.assign(next[last - 1], { open: 101, high: 103, low: 101, close: 103 });
  Object.assign(next[last], { open: 103, high: 130, low: 100, close: 130 });
  return next;
}

function oppositeFade(candles: Candle[]): Candle[] {
  const next = clone(candles);
  const last = next.length - 1;
  Object.assign(next[last - 2], { open: 100, high: 101, low: 100, close: 101 });
  Object.assign(next[last - 1], { open: 101, high: 102, low: 101, close: 102 });
  Object.assign(next[last], { open: 140, high: 140, low: 100, close: 110 });
  return next;
}

function signedName(direction: SignedDirection): string {
  if (direction === 1) return 'UP';
  if (direction === -1) return 'DOWN';
  return 'NONE';
}

async function main(): Promise<void> {
  assert.equal(AND_PREM_TBR_ID, 'and_prem_tbr');
  assert.equal(AND_PREM_TBR_NAME, '溢价逆势 ∩ 主动买比极端逆势');
  assert.equal(AND_3SAME_PREM_ID, 'and_3same_prem');
  assert.equal(AND_3SAME_PREM_NAME, '连涨 3 根逆势 ∩ 溢价逆势');
  assert.equal(AND_3SAME_HIGHVOL_ID, 'and_3same_highvol');
  assert.equal(AND_3SAME_HIGHVOL_NAME, '连涨 3 根逆势 ∩ 高波动 ATR 逆势');
  assert.equal(POST_HOC_MARK, '「事后组合 · 未通过 · 仅监控」');
  assert.equal(ATR_PERIOD, 14);
  assert.equal(ATR_FADE_THRESHOLD, 1.5);
  assert.equal(HIGHVOL_LOOKBACK, 200);
  assert.equal(FADE_3SAME_ATR, 1.5);
  assert.equal(TBR_HIGH, 0.70);
  assert.equal(TBR_LOW, 0.30);
  assert.equal(PREM_Z_WINDOW, 288);
  assert.equal(PREM_Z_THRESHOLD, 3);
  assert.equal(COMBO_WARMUP_BARS, 300);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3]), 3);

  const atrFixture = wilderAtr14([
    { open: 100, high: 110, low: 100, close: 105 },
    { open: 105, high: 112, low: 102, close: 108 },
    { open: 108, high: 130, low: 108, close: 128 }
  ]);
  assert.equal(atrFixture[0], 10);
  assert.equal(atrFixture[1], 10);
  assert.ok(Math.abs(atrFixture[2] - (152 / 14)) < 1e-12, `ATR ${atrFixture[2]}`);
  const pythonAtr = execFileSync('python3', ['-c', 'alpha=1/14\nprev=10.0\nprev=(1-alpha)*prev+alpha*22\nprint(repr(prev))'], { encoding: 'utf8' }).trim();
  assert.ok(Math.abs(atrFixture[2] - Number(pythonAtr)) < 1e-12);

  const history = series(301);
  const premWindow = priorPrem(history, 300);
  const premStd = sampleStd(premWindow);
  const pythonStd = Number(execFileSync('python3', ['-c', `
vals = []
for i in range(12, 300):
    vals.append(1.0 if i % 2 == 0 else -1.0)
mean = sum(vals)/len(vals)
var = sum((v-mean)**2 for v in vals)/(len(vals)-1)
print(repr(var ** 0.5))
`], { encoding: 'utf8' }).trim());
  assert.ok(Math.abs(premStd - pythonStd) < 1e-12, `std ${premStd} vs ${pythonStd}`);
  assert.ok(premStd > 0);

  const premShort = armPremAndTbr(history, premStd * 3, 80);
  const premLong = armPremAndTbr(history, premStd * -3, 20);
  const premBelow = armPremAndTbr(history, premStd * 2.5, 80);
  assert.equal(premZFade(premShort, 300), -1, 'prem_z >= 3 做空');
  assert.equal(premZFade(premLong, 300), 1, 'prem_z <= -3 做多');
  assert.equal(premZFade(premBelow, 300), 0, 'prem_z 未到 3 无信号');
  assert.equal(tbrExtremeFade(premShort, 300), -1, 'tbr >= 0.70 做空');
  assert.equal(tbrExtremeFade(premLong, 300), 1, 'tbr <= 0.30 做多');
  assert.equal(tbrExtremeFade(armPremAndTbr(history, 0, 50), 300), 0, 'tbr 在 0.30 和 0.70 之间无信号');
  assert.equal(tbrExtremeFade(armPremAndTbr(history, 0, 70), 300), -1, 'tbr 正好 0.70 做空');
  assert.equal(tbrExtremeFade(armPremAndTbr(history, 0, 30), 300), 1, 'tbr 正好 0.30 做多');
  assert.equal(tbrExtremeFade(armPremAndTbr(history, 0, 69), 300), 0);
  assert.equal(tbrExtremeFade(armPremAndTbr(history, 0, 31), 300), 0);

  const flatPrem = series(301, (_index, candle) => { candle.prem = 1; });
  flatPrem[300].prem = 10;
  assert.equal(premZFade(flatPrem, 300), 0, '标准差为 0 无信号');
  const missingPremBar = clone(premShort);
  missingPremBar[200].prem = null;
  assert.equal(premZFade(missingPremBar, 300), 0, '窗口里缺溢价无信号');
  const missingCurrentPrem = clone(premShort);
  missingCurrentPrem[300].prem = null;
  assert.equal(premZFade(missingCurrentPrem, 300), 0, '当前溢价缺失无信号');
  const zeroVolume = armPremAndTbr(history, premStd * 3, 0, 0);
  assert.equal(tbrExtremeFade(zeroVolume, 300), 0, 'volume=0 无信号');
  const missingVolume = armPremAndTbr(history, premStd * 3, 80);
  delete missingVolume[300].volume;
  assert.equal(tbrExtremeFade(missingVolume, 300), 0, 'volume 缺失无信号');
  const missingTaker = armPremAndTbr(history, premStd * 3, 80);
  delete missingTaker[300].takerBuyBase;
  assert.equal(tbrExtremeFade(missingTaker, 300), 0, '主动买量缺失无信号');

  const gapped = clone(premShort);
  gapped[250].openTime = (gapped[250].openTime as number) + FIVE_MIN_MS;
  assert.equal(premZFade(gapped, 300), 0, '溢价窗口有缺口无信号');

  const shortOnly = series(40);
  shortOnly[39] = { ...shortOnly[39], open: 100, high: 102, low: 100, close: 102 };
  const shortAtr = wilderAtr14(shortOnly);
  const shortRatio = (shortOnly[39].close - shortOnly[39].open) / shortAtr[39];
  assert.ok(shortRatio >= 1.5, `body/atr ${shortRatio}`);
  assert.equal(fadeAtr15(shortOnly, 39, shortAtr), -1, 'fade_atr15 单独做空');
  assert.equal(fadeAtr15Highvol(shortOnly, 39, shortAtr), 0, '不足 200 根时高波动过滤单独不触发');

  const longOnly = series(40);
  longOnly[39] = { ...longOnly[39], open: 100, high: 100, low: 98, close: 98 };
  const longAtr = wilderAtr14(longOnly);
  assert.equal(fadeAtr15(longOnly, 39, longAtr), 1, 'fade_atr15 单独做多');

  const mild = series(40);
  mild[39] = { ...mild[39], open: 100, high: 101, low: 100, close: 101 };
  const mildAtr = wilderAtr14(mild);
  const mildRatio = (mild[39].close - mild[39].open) / mildAtr[39];
  assert.ok(mildRatio < 1.5 && mildRatio > -1.5, `mild ratio ${mildRatio}`);
  assert.equal(fadeAtr15(mild, 39, mildAtr), 0, '不到 1.5 倍 ATR 无信号');

  const highvolBars = risingFade(history);
  const highvolAtr = wilderAtr14(highvolBars);
  assert.equal(fade3Same(highvolBars, 300, highvolAtr), -1, 'fade_3same 单独做空');
  assert.equal(fadeAtr15(highvolBars, 300, highvolAtr), -1, '同一根 fade_atr15 做空');
  assert.equal(fadeAtr15Highvol(highvolBars, 300, highvolAtr), -1, '高波动过滤后仍做空');
  const priorNatr: number[] = [];
  for (let i = 100; i < 300; i++) priorNatr.push(highvolAtr[i] / highvolBars[i].close);
  const natrNow = highvolAtr[300] / highvolBars[300].close;
  assert.ok(natrNow > median(priorNatr), `natr ${natrNow} 应高于前 200 根中位数 ${median(priorNatr)}`);

  const downStreak = series(20);
  downStreak[16].close = 100;
  downStreak[17] = { ...downStreak[17], open: 100, high: 100, low: 99, close: 99 };
  downStreak[18] = { ...downStreak[18], open: 99, high: 99, low: 97, close: 97 };
  downStreak[19] = { ...downStreak[19], open: 97, high: 97, low: 70, close: 70 };
  const downAtr = wilderAtr14(downStreak);
  assert.equal(fade3Same(downStreak, 19, downAtr), 1, '连跌 3 根单独做多');

  const notStrict = series(10);
  notStrict[9].close = 101;
  notStrict[8].close = 101;
  notStrict[7].close = 100;
  assert.equal(fade3Same(notStrict, 9, wilderAtr14(notStrict)), 0, '收盘没有严格同向无信号');

  const wide = series(220, (_index, candle) => {
    candle.high = 110;
    candle.low = 90;
  });
  wide[217] = { ...wide[217], open: 100, high: 110, low: 99, close: 110 };
  wide[218] = { ...wide[218], open: 110, high: 120, low: 109, close: 120 };
  wide[219] = { ...wide[219], open: 120, high: 145, low: 119, close: 145 };
  const wideAtr = wilderAtr14(wide);
  const wideIndex = 219;
  assert.equal(fade3Same(wide, wideIndex, wideAtr), -1, '大波动背景里 fade_3same 仍可单独触发');
  const widePrior: number[] = [];
  for (let i = wideIndex - 200; i < wideIndex; i++) widePrior.push(wideAtr[i] / wide[i].close);
  const wideNatr = wideAtr[wideIndex] / wide[wideIndex].close;
  assert.ok(!(wideNatr > median(widePrior)), `这根不该算高波动 natr=${wideNatr} med=${median(widePrior)}`);
  assert.equal(fadeAtr15Highvol(wide, wideIndex, wideAtr), 0, '不超过中位数时高波动逆势无信号');

  const warmup = series(300);
  const warmupStd = sampleStd(priorPrem(warmup, 299));
  const warmupArmed = armPremAndTbr(warmup, warmupStd * 3, 80);
  assert.equal(premZFade(warmupArmed, 299), -1, '第 300 根上溢价组件自己可以触发');
  assert.equal(tbrExtremeFade(warmupArmed, 299), -1, '第 300 根上主动买比组件自己可以触发');
  assert.equal(evaluateAndPremTbr(warmupArmed), null, '前 300 根即使两边同向也不出组合');

  const samePremTbr = armPremAndTbr(history, premStd * 3, 80);
  const warmedPremTbr = evaluateAndPremTbr(samePremTbr);
  assert.ok(warmedPremTbr, '预热后同向应出 and_prem_tbr');
  assert.equal(warmedPremTbr?.direction, 'DOWN');
  assert.equal(warmedPremTbr?.postHoc, true);
  assert.ok(warmedPremTbr?.reason.includes(POST_HOC_MARK));
  assert.ok(warmedPremTbr?.reason.includes(AND_PREM_TBR_NAME));
  assert.ok(warmedPremTbr?.reason.includes('不下单'));

  const oppositePremTbr = armPremAndTbr(history, premStd * 3, 20);
  assert.equal(premZFade(oppositePremTbr, 300), -1);
  assert.equal(tbrExtremeFade(oppositePremTbr, 300), 1);
  assert.equal(evaluateAndPremTbr(oppositePremTbr), null, '方向相反不出 and_prem_tbr');
  assert.equal(evaluateAndPremTbr(armPremAndTbr(history, premStd * 3, 50)), null, '只有溢价一边不出组合');
  assert.equal(evaluateAndPremTbr(armPremAndTbr(history, 0, 80)), null, '只有主动买比一边不出组合');
  assert.equal(evaluateAndPremTbr(missingCurrentPrem), null, '缺溢价不出溢价组合');
  assert.equal(evaluateAndPremTbr(zeroVolume), null, '缺成交量不出主动买比组合');

  const bothPrice = armPremAndTbr(risingFade(history), premStd * 3, 80);
  const priceAtr = wilderAtr14(bothPrice);
  assert.equal(fade3Same(bothPrice, 300, priceAtr), -1);
  assert.equal(fadeAtr15Highvol(bothPrice, 300, priceAtr), -1);
  assert.equal(premZFade(bothPrice, 300), -1);
  assert.equal(tbrExtremeFade(bothPrice, 300), -1);
  assert.equal(evaluateAnd3SamePrem(bothPrice)?.direction, 'DOWN');
  assert.equal(evaluateAnd3SameHighvol(bothPrice)?.direction, 'DOWN');
  assert.equal(evaluateAndPremTbr(bothPrice)?.direction, 'DOWN');

  const premOppositePrice = armPremAndTbr(risingFade(history), premStd * -3, 80);
  assert.equal(fade3Same(premOppositePrice, 300, wilderAtr14(premOppositePrice)), -1);
  assert.equal(premZFade(premOppositePrice, 300), 1);
  assert.equal(evaluateAnd3SamePrem(premOppositePrice), null, '连涨逆势和溢价方向相反，不出组合');
  assert.equal(evaluateAnd3SameHighvol(premOppositePrice)?.direction, 'DOWN', '高波动组合不依赖溢价');

  const highvolOpposite = armPremAndTbr(oppositeFade(history), premStd * 3, 80);
  const oppositeAtr = wilderAtr14(highvolOpposite);
  assert.equal(fade3Same(highvolOpposite, 300, oppositeAtr), -1, `3same ${signedName(fade3Same(highvolOpposite, 300, oppositeAtr))}`);
  assert.equal(fadeAtr15Highvol(highvolOpposite, 300, oppositeAtr), 1, `highvol ${signedName(fadeAtr15Highvol(highvolOpposite, 300, oppositeAtr))}`);
  assert.equal(evaluateAnd3SameHighvol(highvolOpposite), null, '连涨逆势和高波动 ATR 方向相反，不出组合');

  const noPrem = clone(bothPrice);
  noPrem[300].prem = null;
  assert.equal(evaluateAndPremTbr(noPrem), null);
  assert.equal(evaluateAnd3SamePrem(noPrem), null);
  assert.equal(evaluateAnd3SameHighvol(noPrem)?.direction, 'DOWN', '缺溢价时只剩不依赖溢价的组合');
  const noVolume = clone(bothPrice);
  noVolume[300].volume = 0;
  assert.equal(evaluateAndPremTbr(noVolume), null);
  assert.equal(evaluateAnd3SamePrem(noVolume)?.direction, 'DOWN');
  assert.equal(evaluateAnd3SameHighvol(noVolume)?.direction, 'DOWN');

  const spotSignals = evaluateStrategies(bothPrice, 'spot');
  assert.deepEqual(spotSignals.map(signal => signal.strategyId).sort(), [
    AND_3SAME_HIGHVOL_ID,
    AND_3SAME_PREM_ID,
    AND_PREM_TBR_ID
  ].sort());
  assert.equal(evaluateStrategies(bothPrice).length, 0, '默认只跑指数趋势策略，不能把现货组合算进去');
  assert.ok(spotSignals.every(signal => signal.postHoc === true));

  for (const id of [AND_PREM_TBR_ID, AND_3SAME_PREM_ID, AND_3SAME_HIGHVOL_ID]) {
    const definition = getStrategyDefinition(id);
    assert.ok(definition);
    assert.equal(definition?.dataSource, 'spot');
    assert.equal(definition?.postHoc, true);
    assert.equal(definition?.officialStatus, 'FAIL');
    assert.equal(definition?.enabled, true);
    assert.ok(definition?.name.startsWith(POST_HOC_MARK));
    assert.ok(definition?.summary.includes(POST_HOC_MARK));
    assert.ok(definition?.summary.includes('FAIL'));
    assert.ok(definition?.summary.includes('不下单'));
  }
  assert.ok(getStrategyDefinition(AND_PREM_TBR_ID)?.name.includes(AND_PREM_TBR_NAME));
  assert.equal(getStrategyDefinition(AND_PREM_TBR_ID)?.name, monitorLabel(AND_PREM_TBR_NAME));
  assert.ok(getStrategyDefinition(AND_3SAME_PREM_ID)?.name.includes(AND_3SAME_PREM_NAME));
  assert.ok(getStrategyDefinition(AND_3SAME_HIGHVOL_ID)?.name.includes(AND_3SAME_HIGHVOL_NAME));
  assert.ok(getStrategyDefinition(AND_PREM_TBR_ID)?.summary.includes('N=480'));
  assert.ok(getStrategyDefinition(AND_PREM_TBR_ID)?.summary.includes('59.38%'));
  assert.ok(getStrategyDefinition(AND_3SAME_PREM_ID)?.summary.includes('53.85%'));
  assert.ok(getStrategyDefinition(AND_3SAME_HIGHVOL_ID)?.summary.includes('57.79%'));

  const indexIds = ['multi-cross-engulf-long', 'multi-cross-engulf-short', 'strong-rally-pullback-long', 'strong-drop-pullback-short'];
  assert.deepEqual(strategies.filter(strategy => strategy.dataSource === 'index').map(strategy => strategy.id), indexIds);
  assert.equal(getStrategyDefinition('multi-cross-engulf-long')?.evaluate, evaluateMultiCrossEngulfLong);
  assert.equal(getStrategyDefinition('multi-cross-engulf-short')?.evaluate, evaluateMultiCrossEngulfShort);
  assert.equal(getStrategyDefinition('strong-rally-pullback-long')?.evaluate, evaluateStrongRallyPullbackLong);
  assert.equal(getStrategyDefinition('strong-drop-pullback-short')?.evaluate, evaluateStrongDropPullbackShort);
  assert.equal(LONG_LOOKBACK, 20);
  assert.equal(LONG_CROSSES, 2);
  assert.equal(NEAR_ABOVE_PCT, 0.30);
  assert.equal(SHORT_LOOKBACK, 20);
  assert.equal(SHORT_CROSSES, 2);
  assert.equal(NEAR_BELOW_PCT, 0.30);
  assert.equal(RALLY_LOOKBACK, 20);
  assert.equal(RALLY_BARS, 3);
  assert.equal(RALLY_MULTIPLE, 2);
  assert.equal(RALLY_WEAK, 0.5);
  assert.equal(RALLY_RETRACE, 0.5);
  assert.equal(DROP_LOOKBACK, 20);
  assert.equal(DROP_BARS, 3);
  assert.equal(DROP_MULTIPLE, 2);
  assert.equal(DROP_WEAK, 0.5);
  assert.equal(DROP_RETRACE, 0.5);
  for (const file of [
    'src/strategies/multiCrossEngulfLong.ts',
    'src/strategies/multiCrossEngulfShort.ts',
    'src/strategies/strongRallyPullbackLong.ts',
    'src/strategies/strongDropPullbackShort.ts'
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes('prem'), false, `${file} 不应改去读溢价`);
    assert.equal(source.includes('takerBuy'), false, `${file} 不应改去读主动买量`);
    assert.equal(source.includes('comboFade'), false, `${file} 不应引用事后组合`);
  }

  const listed = listStrategyDefinitions();
  for (const item of listed.filter(definition => definition.postHoc)) {
    assert.ok(item.name.includes(POST_HOC_MARK));
    assert.equal(item.officialStatus, 'FAIL');
    assert.equal(item.dataSource, 'spot');
  }

  const priority = [
    AND_PREM_TBR_ID,
    AND_3SAME_PREM_ID,
    AND_3SAME_HIGHVOL_ID,
    ...strategies.filter(strategy => strategy.dataSource === 'index').map(strategy => strategy.id)
  ];
  assert.deepEqual(priority.map(klineTradeRank), priority.map((_, index) => index));
  assert.deepEqual(priority.slice(3), indexIds);
  assert.ok(klineTradeRank(AND_PREM_TBR_ID) < klineTradeRank(AND_3SAME_PREM_ID));
  assert.ok(klineTradeRank(AND_3SAME_HIGHVOL_ID) < klineTradeRank('multi-cross-engulf-long'));

  const memory = new MemoryTrades();
  const service = new TradingSignalService(memory);
  const saved = await service.generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(saved.map(signal => signal.strategyId), [AND_PREM_TBR_ID], '同一根K线同向只留胜率最高的 and_prem_tbr');
  assert.equal(saved[0].signal, 'SELL');
  assert.equal(saved[0].prediction, 'DOWN');
  assert.equal(memory.docs.length, 1);
  assert.equal(memory.docs[0].klineCloseTime, bothPrice[300].closeTime);
  assert.equal(memory.docs[0].price, bothPrice[bothPrice.length - 1].close);
  assert.equal(memory.docs[0].orderSource, 'AUTO');
  assert.ok(saved[0].postHoc && saved[0].strategyName?.includes(POST_HOC_MARK));
  assert.ok(saved[0].recommendedAction.includes('不下单') && saved[0].recommendedAction.includes(POST_HOC_MARK));
  assert.ok(!saved.some(signal => signal.strategyId === AND_3SAME_PREM_ID));
  assert.ok(!saved.some(signal => signal.strategyId === AND_3SAME_HIGHVOL_ID));
  const again = await service.generateSignal('BTCUSDT', [], [], bothPrice);
  assert.equal(again.length, 0, '同一策略同一根K线不能再记一笔');
  assert.equal(memory.docs.length, 1);
  memory.docs.length = 0;
  const blockedBySlot = await service.generateSignal('BTCUSDT', [], [], bothPrice);
  assert.equal(blockedBySlot.length, 0, '这根K线已经选过一笔，清掉记录也不会再让别的策略补上');
  assert.equal(memory.docs.length, 0);

  const incidentClose = 1794635999999;
  const incidentBars = clone(bothPrice);
  incidentBars[300].closeTime = incidentClose;
  const incidentMemory = new MemoryTrades();
  const incidentSaved = await new TradingSignalService(incidentMemory).generateSignal('BTCUSDT', [], [], incidentBars);
  assert.deepEqual(incidentSaved.map(signal => signal.strategyId), [AND_PREM_TBR_ID], 'and_prem_tbr 胜过 and_3same_prem');
  assert.equal(incidentSaved[0].signal, 'SELL');
  assert.equal(incidentMemory.docs[0].tradeType, 'SHORT');
  assert.equal(incidentMemory.docs[0].klineCloseTime, incidentClose);
  assert.ok(evaluateStrategies(incidentBars, 'spot').some(signal => signal.strategyId === AND_3SAME_PREM_ID && signal.direction === 'DOWN'));

  const premMemory = new MemoryTrades();
  const withoutPremium = await new TradingSignalService(premMemory).generateSignal('BTCUSDT', [], [], noPrem);
  assert.deepEqual(withoutPremium.map(signal => signal.strategyId), [AND_3SAME_HIGHVOL_ID]);
  const withoutVolume = clone(bothPrice);
  withoutVolume[300].volume = 0;
  const volumeMemory = new MemoryTrades();
  const volumeSaved = await new TradingSignalService(volumeMemory).generateSignal('BTCUSDT', [], [], withoutVolume);
  assert.deepEqual(volumeSaved.map(signal => signal.strategyId), [AND_3SAME_PREM_ID], '没有 and_prem_tbr 时留下下一名');

  const targetClose = (bothPrice[300].closeTime as number) + HOLD_DURATION_MS;
  const spotLoader = async () => [{ closeTime: targetClose, close: '12345.5' }];
  assert.equal(await settlementPriceForTrade({ strategyId: AND_PREM_TBR_ID, klineCloseTime: bothPrice[300].closeTime }, 999, targetClose + 5, spotLoader), 12345.5);
  assert.equal(await settlementPriceForTrade({ strategyId: AND_PREM_TBR_ID, klineCloseTime: bothPrice[300].closeTime }, 999, targetClose, spotLoader), null);
  assert.equal(await settlementPriceForTrade({ strategyId: 'multi-cross-engulf-long', klineCloseTime: bothPrice[300].closeTime }, 888, targetClose + 5, async () => {
    throw new Error('趋势策略不应拉现货来结算');
  }), 888);
  assert.equal(await settlementPriceForTrade({ strategyId: AND_3SAME_PREM_ID, klineCloseTime: bothPrice[300].closeTime }, 1, targetClose + 5, async () => []), null);

  const capped = new MemoryTrades();
  const aged = new Date(Date.now() - 11 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    capped.docs.push(paperTrade({
      timestamp: aged,
      klineCloseTime: i,
      strategyId: AND_PREM_TBR_ID,
      strategyName: monitorLabel(AND_PREM_TBR_NAME)
    }));
  }
  const cappedSaved = await new TradingSignalService(capped).generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(cappedSaved.map(signal => signal.strategyId), [AND_3SAME_PREM_ID], '达到单策略上限就换下一名，更低的不再记');
  assert.equal(capped.docs.filter(doc => doc.klineCloseTime === bothPrice[300].closeTime).length, 1);

  const recentTop = new MemoryTrades();
  recentTop.docs.push(paperTrade({
    klineCloseTime: 1,
    strategyId: AND_PREM_TBR_ID,
    strategyName: monitorLabel(AND_PREM_TBR_NAME)
  }));
  const recentSaved = await new TradingSignalService(recentTop).generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(recentSaved.map(signal => signal.strategyId), [AND_3SAME_PREM_ID], '最近 10 分钟同向未平仓只跳过这一条策略');

  const blocked = new MemoryTrades();
  blocked.docs.push(paperTrade({
    klineCloseTime: 1,
    strategyId: AND_3SAME_HIGHVOL_ID,
    strategyName: monitorLabel(AND_3SAME_HIGHVOL_NAME)
  }));
  const blockedSaved = await new TradingSignalService(blocked).generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(blockedSaved.map(signal => signal.strategyId), [AND_PREM_TBR_ID], '同向限制按策略分开，不挡住更高优先级');

  const sharedClose = bothPrice[300].closeTime as number;
  const indexShort = alignClose(engulfShortIndex(), sharedClose);
  assert.ok(evaluateStrategies(indexShort, 'index').some(signal => signal.strategyId === 'multi-cross-engulf-short' && signal.direction === 'DOWN'));
  const comboBeatsTrend = new MemoryTrades();
  const comboBeatsTrendSaved = await new TradingSignalService(comboBeatsTrend).generateSignal('BTCUSDT', indexShort, [], bothPrice);
  assert.deepEqual(comboBeatsTrendSaved.map(signal => signal.strategyId), [AND_PREM_TBR_ID], '同一根K线同向时组合优先于趋势策略');
  assert.equal(comboBeatsTrend.docs[0].price, bothPrice[bothPrice.length - 1].close);
  assert.equal(comboBeatsTrend.docs[0].klineCloseTime, sharedClose);
  assert.equal(comboBeatsTrendSaved[0].postHoc, true);

  const trendOnly = new MemoryTrades();
  const trendSaved = await new TradingSignalService(trendOnly).generateSignal('BTCUSDT', engulfShortIndex(), [], []);
  assert.deepEqual(trendSaved.map(signal => signal.strategyId), ['multi-cross-engulf-short']);
  assert.equal(trendSaved[0].postHoc, false);
  assert.equal(trendSaved[0].signal, 'SELL');
  assert.ok(trendSaved[0].recommendedAction.includes('建议开仓做空'));
  assert.equal(trendSaved[0].recommendedAction.includes('不下单'), false);

  const indexLong = alignClose(engulfLongIndex(), sharedClose);
  assert.ok(evaluateStrategies(indexLong, 'index').some(signal => signal.strategyId === 'multi-cross-engulf-long' && signal.direction === 'UP'));
  const oppositeMemory = new MemoryTrades();
  const oppositeSaved = await new TradingSignalService(oppositeMemory).generateSignal('BTCUSDT', indexLong, [], bothPrice);
  assert.equal(oppositeSaved.length, 0, '同一根K线多空都有信号时一笔都不记');
  assert.equal(oppositeMemory.docs.length, 0);

  const opposedSpot = armPremAndTbr(fallingOpposite(history), premStd * 3, 80);
  assert.equal(evaluateAndPremTbr(opposedSpot)?.direction, 'DOWN');
  assert.equal(evaluateAnd3SamePrem(opposedSpot), null);
  assert.equal(evaluateAnd3SameHighvol(opposedSpot)?.direction, 'UP');
  const opposedMemory = new MemoryTrades();
  const opposedService = new TradingSignalService(opposedMemory);
  const opposedSaved = await opposedService.generateSignal('BTCUSDT', [], [], opposedSpot);
  assert.equal(opposedSaved.length, 0, '两条组合方向相反时整根跳过，不因为优先级高就留下空单');
  assert.equal(opposedMemory.docs.length, 0);
  const afterDiscard = await opposedService.generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(afterDiscard.map(signal => signal.strategyId), [AND_PREM_TBR_ID], '被整根丢掉的信号不占槽，下一轮仍可记');

  const splitClose = sharedClose + FIVE_MIN_MS;
  const splitMemory = new MemoryTrades();
  const splitSaved = await new TradingSignalService(splitMemory).generateSignal('BTCUSDT', alignClose(engulfLongIndex(), splitClose), [], bothPrice);
  assert.equal(splitSaved.length, 2, '收盘时间不同，多空各记一笔');
  assert.equal(splitMemory.docs.find(doc => doc.klineCloseTime === sharedClose)?.strategyId, AND_PREM_TBR_ID);
  assert.equal(splitMemory.docs.find(doc => doc.klineCloseTime === splitClose)?.strategyId, 'multi-cross-engulf-long');

  const twoBars = new MemoryTrades();
  const twoBarService = new TradingSignalService(twoBars);
  const firstBar = await twoBarService.generateSignal('BTCUSDT', [], [], bothPrice);
  assert.deepEqual(firstBar.map(signal => signal.strategyId), [AND_PREM_TBR_ID]);
  twoBars.docs[0].timestamp = new Date(Date.now() - 11 * 60 * 1000);
  const secondBar = await twoBarService.generateSignal('BTCUSDT', [], [], shiftTimes(bothPrice, FIVE_MIN_MS));
  assert.deepEqual(secondBar.map(signal => signal.strategyId), [AND_PREM_TBR_ID], '另一根K线不受上一根限制');
  assert.equal(twoBars.docs.length, 2);
  assert.notEqual(twoBars.docs[0].klineCloseTime, twoBars.docs[1].klineCloseTime);

  const nextBarWhileOpen = new MemoryTrades();
  const nextBarService = new TradingSignalService(nextBarWhileOpen);
  await nextBarService.generateSignal('BTCUSDT', [], [], bothPrice);
  const whileOpen = await nextBarService.generateSignal('BTCUSDT', [], [], shiftTimes(bothPrice, FIVE_MIN_MS * 2));
  assert.deepEqual(whileOpen.map(signal => signal.strategyId), [AND_3SAME_PREM_ID], '10 分钟同向限制只挡住同一条策略，下一根K线仍可记');
  assert.equal(new Set(nextBarWhileOpen.docs.map(doc => doc.klineCloseTime)).size, 2);

  const otherSymbol = new MemoryTrades();
  const symbolService = new TradingSignalService(otherSymbol);
  const btcSaved = await symbolService.generateSignal('BTCUSDT', [], [], incidentBars);
  const ethSaved = await symbolService.generateSignal('ETHUSDT', [], [], incidentBars);
  assert.deepEqual(btcSaved.map(signal => signal.strategyId), [AND_PREM_TBR_ID]);
  assert.deepEqual(ethSaved.map(signal => signal.strategyId), [AND_PREM_TBR_ID]);
  assert.deepEqual(otherSymbol.docs.map(doc => doc.symbol).sort(), ['BTCUSDT', 'ETHUSDT']);

  const alreadyThere = new MemoryTrades();
  alreadyThere.docs.push(paperTrade({
    timestamp: aged,
    price: 67241.29,
    klineCloseTime: incidentClose,
    strategyId: AND_3SAME_PREM_ID,
    strategyName: monitorLabel(AND_3SAME_PREM_NAME)
  }));
  const alreadySaved = await new TradingSignalService(alreadyThere).generateSignal('BTCUSDT', [], [], incidentBars);
  assert.equal(alreadySaved.length, 0, '这根K线已经有任意策略的交易时不再记');
  assert.equal(alreadyThere.docs.length, 1);
  assert.equal(alreadyThere.docs[0].strategyId, AND_3SAME_PREM_ID);

  const feishu = formatFeishuOpenText(saved[0], bothPrice[bothPrice.length - 1].closeTime as number);
  assert.ok(feishu.includes(POST_HOC_MARK));
  assert.ok(feishu.includes('FAIL'));
  assert.ok(feishu.includes('不下单'));
  assert.ok(feishu.includes(saved[0].strategyName || ''));
  assert.equal(feishu.includes('建议开仓'), false);

  const now = bothPrice[bothPrice.length - 1].closeTime as number + 10;
  const aligned = alignClosedSpotAndPremium(
    [
      { openTime: 0, open: '1', high: '2', low: '0.5', close: '1.5', closeTime: 100, volume: '10', takerBuyBaseAssetVolume: '7' },
      { openTime: FIVE_MIN_MS, open: '1.5', high: '2', low: '1', close: '1.8', closeTime: now, volume: '11', takerBuyBaseAssetVolume: '1' }
    ],
    [
      { openTime: 0, open: '0.1', high: '0.2', low: '0', close: '0.15', closeTime: 100 },
      { openTime: FIVE_MIN_MS * 3, open: '0', high: '0', low: '0', close: '9', closeTime: 100 }
    ],
    now
  );
  assert.equal(aligned.length, 1, '未收盘的现货 K 线不能参与');
  assert.equal(aligned[0].close, 1.5);
  assert.equal(aligned[0].volume, 10);
  assert.equal(aligned[0].takerBuyBase, 7);
  assert.equal(aligned[0].prem, 0.15);
  const missingPremium = alignClosedSpotAndPremium(
    [{ openTime: 5, open: 1, high: 1, low: 1, close: 1, closeTime: 10, volume: 3, takerBuyBase: 1 }],
    [],
    11
  );
  assert.equal(missingPremium[0].prem, null);
  assert.equal(missingPremium[0].volume, 3);
  assert.ok(SPOT_COMBO_FETCH_LIMIT >= 600);

  assert.equal(typeof (BinanceService.prototype as unknown as { placeOrder?: unknown }).placeOrder, 'undefined');
  assert.equal(typeof BinanceService.prototype.getSpotKlines, 'function');
  assert.equal(typeof BinanceService.prototype.getPremiumIndexKlines, 'function');
  const watchedFiles = [
    'src/services/BinanceService.ts',
    'src/services/TradingSignal.ts',
    'src/services/spotComboFeed.ts',
    'src/strategies/comboFade.ts',
    'src/index.ts',
    'src/dashboard/server.ts'
  ];
  for (const file of watchedFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(/\/order|newOrder|placeOrder|createOrder|api\/v3\/order|fapi\/v1\/order/.test(source), false, `${file} 出现了下单接口`);
  }
  const feed = fs.readFileSync('src/services/spotComboFeed.ts', 'utf8');
  assert.ok(feed.includes('getSpotKlines'));
  assert.ok(feed.includes('getPremiumIndexKlines'));
  assert.equal(feed.includes('getIndexPriceKlines'), false);
  assert.equal(/getKlines\(/.test(feed), false);
  assert.ok(fs.readFileSync('src/index.ts', 'utf8').includes("getKlines('5m', 400)"));
  assert.ok(fs.readFileSync('src/dashboard/server.ts', 'utf8').includes("getIndexPriceKlines('BTCUSDT', '5m', 400)"));

  const dashboard = fs.readFileSync('src/dashboard/index.html', 'utf8');
  for (const text of [POST_HOC_MARK, AND_PREM_TBR_NAME, AND_3SAME_PREM_NAME, AND_3SAME_HIGHVOL_NAME, '官方 FAIL', '不下单']) {
    assert.ok(dashboard.includes(text), `面板缺少 ${text}`);
  }

  assert.equal(isLegacyKlineUniqueIndex({ unique: true, key: { symbol: 1, klineCloseTime: 1 } }), true);
  assert.equal(isLegacyKlineUniqueIndex({ unique: true, key: { symbol: 1, strategyId: 1, klineCloseTime: 1 } }), false);
  assert.equal(isLegacyKlineUniqueIndex({ unique: false, key: { symbol: 1, klineCloseTime: 1 } }), false);
  const uniqueIndexes = TradeModel.schema.indexes().filter((entry) => entry[1]?.unique);
  assert.equal(uniqueIndexes.length, 1);
  assert.deepEqual(uniqueIndexes[0][0], { symbol: 1, strategyId: 1, klineCloseTime: 1 });
  assert.equal(HOLD_DURATION_MS, 10 * 60 * 1000);
  const settlement = fs.readFileSync('src/services/TradingSignal.ts', 'utf8');
  assert.ok(settlement.includes('investmentAmount * 0.8'));
  assert.ok(settlement.includes('-trade.investmentAmount'));
  assert.ok(settlement.includes('MAX_OPEN_POSITIONS = 5'));
  assert.ok(settlement.includes('strategyId'));

  console.log('combo acceptance tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
