import { BinanceKline, BinanceService } from './BinanceService';
import { Candle, getStrategyDefinition } from '../strategies/registry';
import { COMBO_WARMUP_BARS } from '../strategies/comboFade';
import { HOLD_DURATION_MS } from './TradingSignal';

/** 288 根溢价窗口 + 300 根预热之后还要留下已收盘的信号根。币安单次上限高于 600。 */
export const SPOT_COMBO_FETCH_LIMIT = 600;

export interface AlignableKline {
  openTime: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  closeTime: number;
  volume?: string | number;
  takerBuyBaseAssetVolume?: string | number;
  takerBuyBase?: string | number;
}

/**
 * 现货 5 分钟 K 线和溢价指数按 openTime 对齐。
 * 只保留 closeTime 早于 now 的已收盘 K 线。某一侧缺这根，prem 记为 null，该时刻依赖溢价的规则不出信号。
 * 这里不用指数价格 K 线：指数没有真实 volume / taker buy，价格也和现货不同。
 */
export function alignClosedSpotAndPremium(
  spot: AlignableKline[],
  premium: AlignableKline[],
  nowMs: number
): Candle[] {
  const premByOpen = new Map<number, number>();
  for (const bar of premium) {
    if (!(bar.closeTime < nowMs)) continue;
    const prem = +bar.close;
    if (Number.isFinite(prem)) premByOpen.set(bar.openTime, prem);
  }

  return spot
    .filter(bar => bar.closeTime < nowMs)
    .slice()
    .sort((left, right) => left.openTime - right.openTime)
    .map(bar => {
      const taker = bar.takerBuyBase != null ? bar.takerBuyBase : bar.takerBuyBaseAssetVolume;
      const volume = bar.volume == null || bar.volume === '' ? undefined : +bar.volume;
      const takerBuyBase = taker == null || taker === '' ? undefined : +taker;
      return {
        openTime: bar.openTime,
        open: +bar.open,
        high: +bar.high,
        low: +bar.low,
        close: +bar.close,
        closeTime: bar.closeTime,
        volume: volume != null && Number.isFinite(volume) ? volume : undefined,
        takerBuyBase: takerBuyBase != null && Number.isFinite(takerBuyBase) ? takerBuyBase : undefined,
        prem: premByOpen.has(bar.openTime) ? premByOpen.get(bar.openTime) as number : null
      };
    });
}

export async function loadClosedSpotComboCandles(binance: BinanceService, nowMs = Date.now()): Promise<Candle[]> {
  const spot = await binance.getSpotKlines('5m', SPOT_COMBO_FETCH_LIMIT);
  let premium: BinanceKline[] = [];
  try {
    premium = await binance.getPremiumIndexKlines('5m', SPOT_COMBO_FETCH_LIMIT);
  } catch (error) {
    console.error('溢价指数K线获取失败，依赖溢价的事后组合本轮无信号:', error);
  }
  const candles = alignClosedSpotAndPremium(spot, premium, nowMs);
  if (candles.length <= COMBO_WARMUP_BARS) {
    console.log(`事后组合已收盘现货K线只有 ${candles.length} 根，不足 ${COMBO_WARMUP_BARS} 根预热，本轮不出信号`);
  }
  return candles;
}

type SpotKlineLoader = (interval: string, limit: number, startTime?: number, endTime?: number) => Promise<Array<{ closeTime: number; close: string | number }>>;

/**
 * 趋势策略沿用调用方给的实时价格。
 * 事后组合的结算价是信号 K 线之后第 2 根现货 5 分钟收盘，也就是 10 分钟后的那根收盘。不用指数价。
 */
export async function settlementPriceForTrade(
  trade: { strategyId?: string; klineCloseTime?: number | null },
  livePrice: number,
  nowMs: number,
  loadSpotKlines: SpotKlineLoader
): Promise<number | null> {
  const postHoc = trade.strategyId ? getStrategyDefinition(trade.strategyId)?.postHoc === true : false;
  if (!postHoc) {
    return livePrice > 0 && Number.isFinite(livePrice) ? livePrice : null;
  }
  if (trade.klineCloseTime == null) return null;
  const targetClose = trade.klineCloseTime + HOLD_DURATION_MS;
  if (!(targetClose < nowMs)) return null;
  const klines = await loadSpotKlines('5m', 5, targetClose - 15 * 60 * 1000, targetClose + 1);
  const match = klines.find(kline => kline.closeTime === targetClose);
  if (!match || !(match.closeTime < nowMs)) return null;
  const price = +match.close;
  return price > 0 && Number.isFinite(price) ? price : null;
}
