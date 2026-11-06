import * as ti from 'technicalindicators';
import { IPriceData } from '../models/PriceData';

export interface IndicatorResult {
  ema50: number;
  ema150: number;
  ema200: number;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: number;
}

export interface PredictionResult {
  direction: 'UP' | 'DOWN';
  confidence: number;
  reasoning: string[];
  indicators: IndicatorResult;
}

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class TechnicalAnalysisService {
  /** 10分钟订单块策略保持关闭。 */
  private readonly STRATEGIES_ENABLED = false;
  private readonly EMA50_PERIOD = 50;
  private readonly EMA150_PERIOD = 150;
  private readonly EMA200_PERIOD = 200;

  /**
   * 计算技术指标
   */
  async calculateIndicators(priceHistory: IPriceData[], fiveMinuteKlines: any[]): Promise<IndicatorResult> {
    if (priceHistory.length < 100) {
      throw new Error('需要至少100个价格数据点进行技术分析');
    }

    // 提取收盘分钟K线的收盘价
    const prices = priceHistory.map(p => p.close);

    // 从5分钟K线中提取收盘价
    const fiveMinutePrices = fiveMinuteKlines?.map(p => +p.close) || [];

    // 计算EMA50和EMA150
    const ema50Values = ti.ema({ values: fiveMinutePrices, period: this.EMA50_PERIOD });
    const ema150Values = ti.ema({ values: fiveMinutePrices, period: this.EMA150_PERIOD });
    const ema200Values = ti.ema({ values: fiveMinutePrices, period: this.EMA200_PERIOD });

    const ema50 = +(ema50Values[ema50Values.length - 1] || fiveMinutePrices[fiveMinutePrices.length - 1]);
    const ema150 = +(ema150Values[ema150Values.length - 1] || fiveMinutePrices[fiveMinutePrices.length - 1]);
    const ema200 = +(ema200Values[ema200Values.length - 1] || fiveMinutePrices[fiveMinutePrices.length - 1]);

    // 判断趋势
    const trend = this.determineTrend(ema50, ema150);

    // 计算波动率
    const volatility = this.calculateVolatility(prices);

    return {
      ema50,
      ema150,
      ema200,
      trend,
      volatility
    };
  }

  // 记录最后一根5分K收盘价
  private lastFiveMinuteClosePrice: number = 0;
  // 记录最后一根5分K收盘时间
  private lastFiveMinuteCloseTime: number | null = null;

  // 标记当前5分钟K线是否已经使用过
  private isFiveMinuteUsed: boolean = false;

  /**
   * 重置K线使用状态（用于防止跨调用污染）
   */
  private resetKlineState(): void {
    this.isFiveMinuteUsed = false;
  }

  /**
   * 预测未来10分钟价格走势
   */
  async predictDirection(priceHistory: IPriceData[], fiveMinuteKlines: any[]): Promise<PredictionResult> {
    // 重置K线状态，防止跨调用污染
    this.resetKlineState();

    const indicators = await this.calculateIndicators(priceHistory, fiveMinuteKlines);
    const lastFiveKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];
    this.lastFiveMinuteClosePrice = +lastFiveKline.close;

    // 提取5分钟收盘价并计算EMA50和EMA200序列，用于精确判定趋势斜率与平行度
    const fiveMinutePrices = fiveMinuteKlines?.map(p => +p.close) || [];
    const ema50Values = this.calculateEma(fiveMinutePrices, this.EMA50_PERIOD);
    const ema200Values = this.calculateEma(fiveMinutePrices, this.EMA200_PERIOD);

    // 获取当前K线的收盘时间（确保是number类型）
    const currentCloseTime = typeof lastFiveKline.closeTime === 'number'
      ? lastFiveKline.closeTime
      : lastFiveKline.closeTime.getTime();

    console.log('🔍 TechnicalAnalysis - currentCloseTime:', new Date(currentCloseTime).toLocaleString());
    console.log('🔍 TechnicalAnalysis - lastFiveMinuteCloseTime:', new Date(this.lastFiveMinuteCloseTime || 0).toLocaleString());

    // 如果当前5分钟K线与上一个5分钟K线时间相同，标记为已使用
    // 注意：这里的比较需要精确到毫秒，避免浮点数精度问题
    const timeDiff = Math.abs((this.lastFiveMinuteCloseTime || 0) - currentCloseTime);
    if (timeDiff < 1000 && this.lastFiveMinuteCloseTime !== null) {
      this.isFiveMinuteUsed = true;
      console.log('⚠️  TechnicalAnalysis - K线重复使用，标记为已使用');
    } else {
      this.isFiveMinuteUsed = false;
      this.lastFiveMinuteCloseTime = currentCloseTime;
      console.log('✅ TechnicalAnalysis - 新的K线，状态已更新');
    }

    console.log('🔍 TechnicalAnalysis - isFiveMinuteUsed:', this.isFiveMinuteUsed);

    let score = 0;
    const reasoning: string[] = [];

    /**
     * 沿 EMA50 / EMA200 反包，多空对称。
     * 上涨：阴线收盘不低于 EMA200 的 0.15%，阳线收盘高于阴线实体一半，上穿 EMA50 或 EMA200，高出不超过 0.30%。
     * 下跌：前一根收盘不高于 EMA200 的 0.15%。阳线或阴线的最高价触及 EMA50 或 EMA200，允许差 0.02%；收盘落回该均线下方，低于不超过 0.30%。
     */
    if (!this.isFiveMinuteUsed && fiveMinuteKlines.length >= 2) {
      const trendlineLong = this.detectUptrendTrendlineEngulf(fiveMinuteKlines, ema50Values, ema200Values);
      if (trendlineLong) {
        score = trendlineLong.confidence;
        reasoning.push(trendlineLong.reason);
      } else {
        const trendlineShort = this.detectDowntrendTrendlineEngulf(fiveMinuteKlines, ema50Values, ema200Values);
        if (trendlineShort) {
          score = -trendlineShort.confidence;
          reasoning.push(trendlineShort.reason);
        }
      }
    }

    // 确定趋势方向与置信度
    const direction = score > 0 ? 'UP' : 'DOWN';
    const confidence = Math.abs(score);

    return {
      direction,
      confidence,
      reasoning,
      indicators
    };
  }

  /**
   * 上涨趋势：EMA50 在 EMA200 之上，两条均线最近约 1 小时都至少上涨 0.01%。
   */
  private isRisingEma50Uptrend(ema50Values: number[], ema200Values: number[]): boolean {
    if (!ema50Values || !ema200Values) return false;
    const lookback = Math.min(12, ema200Values.length - 1);
    if (lookback < 5) return false;

    const ema50Recent = ema50Values.slice(-(lookback + 1));
    const ema200Recent = ema200Values.slice(-(lookback + 1));
    const cur50 = ema50Recent[ema50Recent.length - 1];
    const cur200 = ema200Recent[ema200Recent.length - 1];
    if (!(cur50 > cur200)) return false;

    const slope50 = (cur50 - ema50Recent[0]) / ema50Recent[0];
    const slope200 = (cur200 - ema200Recent[0]) / ema200Recent[0];
    return slope50 >= 0.0001 && slope200 >= 0.0001;
  }

  /**
   * 上穿或下穿 EMA50、EMA200 之一，且收盘偏离该均线不超过 0.30%。
   * 两条都满足时取更近的一条。
   */
  private closestMaCross(
    current: any,
    previous: any,
    ema50: number,
    ema200: number,
    direction: 'UP' | 'DOWN'
  ): { name: 'EMA50' | 'EMA200'; distPct: number } | null {
    const close = +current.close;
    const lines: { name: 'EMA50' | 'EMA200'; ma: number }[] = [
      { name: 'EMA50', ma: ema50 },
      { name: 'EMA200', ma: ema200 }
    ];
    let best: { name: 'EMA50' | 'EMA200'; distPct: number } | null = null;

    for (const line of lines) {
      if (!(line.ma > 0)) continue;
      const crossed = direction === 'UP'
        ? this.crossesAboveMa(current, previous, line.ma)
        : this.crossesBelowMa(current, previous, line.ma);
      if (!crossed) continue;

      const distPct = direction === 'UP'
        ? ((close - line.ma) / line.ma) * 100
        : ((line.ma - close) / line.ma) * 100;
      if (distPct > 0.30) continue;
      if (!best || distPct < best.distPct) {
        best = { name: line.name, distPct };
      }
    }

    return best;
  }

  /**
   * 沿均线反包做多。
   * 前一根为阴线，收盘不低于 EMA200 的 0.15%。
   * 当前阳线收盘高于阴线实体的一半，并上穿 EMA50 或 EMA200，高出幅度不超过 0.30%。
   */
  private detectUptrendTrendlineEngulf(
    fiveMinuteKlines: any[],
    ema50Values: number[],
    ema200Values: number[]
  ): { confidence: number; reason: string } | null {
    if (!this.isRisingEma50Uptrend(ema50Values, ema200Values)) return null;
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 2) return null;

    const prev = fiveMinuteKlines[fiveMinuteKlines.length - 2];
    const curr = fiveMinuteKlines[fiveMinuteKlines.length - 1];
    const prevOpen = +prev.open;
    const prevClose = +prev.close;
    const currClose = +curr.close;
    const currOpen = +curr.open;

    const bearishMidpoint = (prevOpen + prevClose) / 2;
    if (!(prevClose < prevOpen && currClose > currOpen && currClose > bearishMidpoint)) {
      return null;
    }

    const ema50 = ema50Values[ema50Values.length - 1];
    const ema200 = ema200Values[ema200Values.length - 1];
    if (!(ema50 > 0) || !(ema200 > 0)) return null;
    if (prevClose < ema200 * 0.9985) return null;

    const cross = this.closestMaCross(curr, prev, ema50, ema200, 'UP');
    if (!cross) return null;

    const confidence = cross.distPct <= 0.15 ? 90 : 85;
    return {
      confidence,
      reason: `趋势策略: 上涨趋势沿EMA50反包做多｜阴线收盘不低于EMA200的0.15%｜阳线收盘过阴线实体一半并上穿${cross.name}｜高出${cross.distPct.toFixed(2)}%｜置信度${confidence}%`
    };
  }

  /**
   * 下跌趋势：EMA50 在 EMA200 之下，两条均线最近约 1 小时都至少下跌 0.01%。
   */
  private isFallingEma50Downtrend(ema50Values: number[], ema200Values: number[]): boolean {
    if (!ema50Values || !ema200Values) return false;
    const lookback = Math.min(12, ema200Values.length - 1);
    if (lookback < 5) return false;

    const ema50Recent = ema50Values.slice(-(lookback + 1));
    const ema200Recent = ema200Values.slice(-(lookback + 1));
    const cur50 = ema50Recent[ema50Recent.length - 1];
    const cur200 = ema200Recent[ema200Recent.length - 1];
    if (!(cur50 < cur200)) return false;

    const slope50 = (cur50 - ema50Recent[0]) / ema50Recent[0];
    const slope200 = (cur200 - ema200Recent[0]) / ema200Recent[0];
    return slope50 <= -0.0001 && slope200 <= -0.0001;
  }

  /**
   * 沿均线受阻做空。
   * 前一根收盘不高于 EMA200 的 0.15%。
   * 当前可以是阳线或阴线：最高价触及 EMA50 或 EMA200，允许低于均线 0.02%；
   * 收盘落回该均线下方，低于幅度不超过 0.30%。
   */
  private detectDowntrendTrendlineEngulf(
    fiveMinuteKlines: any[],
    ema50Values: number[],
    ema200Values: number[]
  ): { confidence: number; reason: string } | null {
    if (!this.isFallingEma50Downtrend(ema50Values, ema200Values)) return null;
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 2) return null;

    const prev = fiveMinuteKlines[fiveMinuteKlines.length - 2];
    const curr = fiveMinuteKlines[fiveMinuteKlines.length - 1];
    const prevClose = +prev.close;

    const ema50 = ema50Values[ema50Values.length - 1];
    const ema200 = ema200Values[ema200Values.length - 1];
    if (!(ema50 > 0) || !(ema200 > 0)) return null;
    if (prevClose > ema200 * 1.0015) return null;

    const cross = this.closestMaCross(curr, prev, ema50, ema200, 'DOWN');
    if (!cross) return null;

    const confidence = cross.distPct <= 0.15 ? 90 : 85;
    return {
      confidence,
      reason: `趋势策略: 下跌趋势沿EMA50反包做空｜前一根收盘不高于EMA200的0.15%｜最高价接近${cross.name}后收在其下｜低于${cross.distPct.toFixed(2)}%｜置信度${confidence}%`
    };
  }

  /**
   * 检查做多时是否遭遇前高阻力
   * 上涨趋势中，如果反包阳线向上冲入前期波段高点/阻力位，但未能有效突破收在阻力位之上，
   * 属于遇前高阻力受阻（高风险追多），应降低置信度。
   */
  private checkResistanceForLong(
    fiveMinuteKlines: any[],
    currKline: any,
    prevKline: any,
    ema50: number
  ): { isResisted: boolean; resistanceLevel: number; reason: string } {
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 5) {
      return { isResisted: false, resistanceLevel: 0, reason: '' };
    }

    const currOpen = +currKline.open;
    const currClose = +currKline.close;
    const currHigh = +currKline.high;
    const currLow = +currKline.low;
    const pullbackLow = Math.min(+prevKline.low, currLow);

    // 回看最近 5~50 根K线（在当前回调反包之前的高点，至少排除当前K线及本轮回踩停顿的3根K线）
    const startIndex = Math.max(0, fiveMinuteKlines.length - 50);
    const endIndex = Math.max(0, fiveMinuteKlines.length - 4);
    const lookback = fiveMinuteKlines.slice(startIndex, endIndex);

    if (lookback.length < 3) {
      return { isResisted: false, resistanceLevel: 0, reason: '' };
    }

    // 收集前高阻力候选位：
    // 1. 最高收盘价（实体阻力位，如用户图示水平蓝线）
    // 2. 最高最高价（影线极值阻力位）
    // 3. 明显的局部波段高点（Pivot Highs）
    const candidateLevels: number[] = [];

    const maxHigh = Math.max(...lookback.map(k => +k.high));
    const maxClose = Math.max(...lookback.map(k => +k.close));
    candidateLevels.push(maxHigh, maxClose);

    // 寻找显著的局部波段高点（比左右各1根都高，且位于EMA50上方）
    for (let i = 1; i < lookback.length - 1; i++) {
      const h = +lookback[i].high;
      const prevH = +lookback[i - 1].high;
      const nextH = +lookback[i + 1].high;
      if (h >= prevH && h >= nextH && h > ema50) {
        candidateLevels.push(h);
        candidateLevels.push(+lookback[i].close);
      }
    }

    // 去重并过滤出高于当前回调低点至少0.25%且高于当前开盘价的有效波段前高阻力位
    const uniqueLevels = Array.from(new Set(candidateLevels));
    const validLevels = uniqueLevels.filter(lvl =>
      lvl > pullbackLow + (currClose * 0.0025) && lvl >= currOpen
    );

    if (validLevels.length === 0) {
      return { isResisted: false, resistanceLevel: 0, reason: '' };
    }

    // 检查是否有阻力位对当前阳线构成压制：
    // 条件：当前最高价触及或逼近阻力位（进入阻力位0.2%区间内，或刺破阻力位），
    // 且收盘未能强势站稳在阻力位上方（收在阻力位下方或平价附近，形成冲高遇阻）
    let matchedLevel: number | null = null;
    let minDiff = Infinity;

    for (const lvl of validLevels) {
      const reachedResistance = currHigh >= lvl * 0.998;
      const failedToBreakout = currClose <= lvl * 1.0008;

      if (reachedResistance && failedToBreakout) {
        const diff = Math.abs(currHigh - lvl);
        if (diff < minDiff) {
          minDiff = diff;
          matchedLevel = lvl;
        }
      }
    }

    if (matchedLevel !== null) {
      const upperShadow = currHigh - Math.max(currOpen, currClose);
      const candleRange = Math.max(1, currHigh - currLow);
      const upperShadowPct = (upperShadow / candleRange) * 100;

      return {
        isResisted: true,
        resistanceLevel: matchedLevel,
        reason: `遭遇前高阻力位(${matchedLevel.toFixed(0)})打压(最高${currHigh.toFixed(0)}触碰阻力，收盘${currClose.toFixed(0)}受阻${upperShadowPct > 15 ? `｜上影${upperShadowPct.toFixed(0)}%` : ''})`
      };
    }

    return { isResisted: false, resistanceLevel: 0, reason: '' };
  }

  /**
   * 检查做空时是否遭遇前低支撑
   * 下跌趋势中，如果反包阴线向下砸入前期波段低点/支撑位，但未能有效跌破收在支撑位之下，
   * 属于遇前低支撑受阻（高风险追空），应降低置信度。
   */
  private checkSupportForShort(
    fiveMinuteKlines: any[],
    currKline: any,
    prevKline: any,
    ema50: number
  ): { isSupported: boolean; supportLevel: number; reason: string } {
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 5) {
      return { isSupported: false, supportLevel: 0, reason: '' };
    }

    const currOpen = +currKline.open;
    const currClose = +currKline.close;
    const currHigh = +currKline.high;
    const currLow = +currKline.low;
    const bounceHigh = Math.max(+prevKline.high, currHigh);

    // 回看最近 5~50 根K线（在当前反弹反包之前的低点，至少排除当前K线及本轮反弹停顿的3根K线）
    const startIndex = Math.max(0, fiveMinuteKlines.length - 50);
    const endIndex = Math.max(0, fiveMinuteKlines.length - 4);
    const lookback = fiveMinuteKlines.slice(startIndex, endIndex);

    if (lookback.length < 3) {
      return { isSupported: false, supportLevel: 0, reason: '' };
    }

    // 收集前低支撑候选位：
    // 1. 最低收盘价（实体支撑位）
    // 2. 最低最低价（影线极值支撑位）
    // 3. 明显的局部波段低点（Pivot Lows）
    const candidateLevels: number[] = [];

    const minLow = Math.min(...lookback.map(k => +k.low));
    const minClose = Math.min(...lookback.map(k => +k.close));
    candidateLevels.push(minLow, minClose);

    // 寻找显著的局部波段低点（比左右各1根都低，且位于EMA50下方）
    for (let i = 1; i < lookback.length - 1; i++) {
      const l = +lookback[i].low;
      const prevL = +lookback[i - 1].low;
      const nextL = +lookback[i + 1].low;
      if (l <= prevL && l <= nextL && l < ema50) {
        candidateLevels.push(l);
        candidateLevels.push(+lookback[i].close);
      }
    }

    // 去重并过滤出低于当前反弹高点至少0.25%且低于当前开盘价的有效波段前低支撑位
    const uniqueLevels = Array.from(new Set(candidateLevels));
    const validLevels = uniqueLevels.filter(lvl =>
      lvl < bounceHigh - (currClose * 0.0025) && lvl <= currOpen
    );

    if (validLevels.length === 0) {
      return { isSupported: false, supportLevel: 0, reason: '' };
    }

    // 检查是否有支撑位对当前阴线构成支撑：
    // 条件：当前最低价触及或逼近支撑位（进入支撑位0.2%区间内，或下刺支撑位），
    // 且收盘未能强势跌破支撑位（收在支撑位上方或平价附近，形成下探遇阻）
    let matchedLevel: number | null = null;
    let minDiff = Infinity;

    for (const lvl of validLevels) {
      const reachedSupport = currLow <= lvl * 1.002;
      const failedToBreakdown = currClose >= lvl * 0.9992;

      if (reachedSupport && failedToBreakdown) {
        const diff = Math.abs(currLow - lvl);
        if (diff < minDiff) {
          minDiff = diff;
          matchedLevel = lvl;
        }
      }
    }

    if (matchedLevel !== null) {
      const lowerShadow = Math.min(currOpen, currClose) - currLow;
      const candleRange = Math.max(1, currHigh - currLow);
      const lowerShadowPct = (lowerShadow / candleRange) * 100;

      return {
        isSupported: true,
        supportLevel: matchedLevel,
        reason: `遭遇前低支撑位(${matchedLevel.toFixed(0)})支撑(最低${currLow.toFixed(0)}触碰支撑，收盘${currClose.toFixed(0)}企稳${lowerShadowPct > 15 ? `｜下影${lowerShadowPct.toFixed(0)}%` : ''})`
      };
    }

    return { isSupported: false, supportLevel: 0, reason: '' };
  }

  /**
   * 反转策略：二次反包确认策略（顶部冲高见顶做空 / 底部探底企稳做多）
   * 对应图示红框反转形态：
   * 1. 局部冲高/探底形成波段极值（Peak / Trough）
   * 2. 初次受阻回落/反弹
   * 3. 出现1~2根弱势反弹/停顿K线，未能突破前极值（无力创新高/新低，形成受阻停顿或双顶/双底）
   * 4. 当前K线出现关键实体反向K线，实施二次反包（顶部大阴反包前阳开盘价/实体，底部大阳反包前阴开盘价/实体）
   * 5. 确认反转确立，置信度 85% ~ 95%（>=80% 核心反转）
   */
  private detectSecondaryEngulfingReversal(
    fiveMinuteKlines: any[],
    indicators: any,
    ema50Values?: number[],
    ema200Values?: number[]
  ): { direction: 'UP' | 'DOWN'; confidence: number; reason: string } | null {
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 5) {
      return null;
    }

    const currKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];
    const prevKline = fiveMinuteKlines[fiveMinuteKlines.length - 2];

    const currOpen = +currKline.open;
    const currClose = +currKline.close;
    const currHigh = +currKline.high;
    const currLow = +currKline.low;
    const currBody = Math.abs(currClose - currOpen);

    const prevOpen = +prevKline.open;
    const prevClose = +prevKline.close;
    const prevHigh = +prevKline.high;
    const prevLow = +prevKline.low;
    const prevBody = Math.abs(prevClose - prevOpen);

    // 最小实体门槛：避免微弱十字星或极小波动误判（如BTC至少15点或万分之二）
    const minBody = Math.max(15, currClose * 0.0002);

    // 回看最近 3 ~ 10 根K线寻找波段极值
    const lookbackStart = Math.max(0, fiveMinuteKlines.length - 10);
    const lookbackCandles = fiveMinuteKlines.slice(lookbackStart, fiveMinuteKlines.length - 1);
    if (lookbackCandles.length < 3) return null;

    // -------------------------------------------------------------------------
    // A. 反转策略：上涨趋势，阴线二次反包做空 (Top Reversal SHORT - 用户图示形态)
    // -------------------------------------------------------------------------
    const isCurrBearish = currClose < currOpen && currBody >= minBody;

    if (isCurrBearish) {
      const peakHigh = Math.max(...lookbackCandles.map(k => +k.high));
      const peakCandle = lookbackCandles.find(k => +k.high === peakHigh);
      const peakIndex = lookbackCandles.findIndex(k => +k.high === peakHigh);

      // 上涨趋势背景判定：严格定义为 EMA50 > EMA200 且斜率差不多一样平行向上
      const isUptrendContext = (ema50Values && ema200Values)
        ? this.isParallelEmaTrend(ema50Values, ema200Values, 'UP')
        : (indicators.ema50 > indicators.ema200);

      // 条件1：当前处于波段冲高之后（最高峰值至少比当前收盘高出0.20%以上）
      const hasElevatedPeak = isUptrendContext && (peakHigh >= currClose * 1.0020);

      // 条件2：摸高后有初次受阻表现（摸高K线留有上影线>=20%或长上影>=15点，或者摸高后收过阴线回调）
      let hadFirstRejection = false;
      if (peakCandle) {
        const pRange = Math.max(1, +peakCandle.high - +peakCandle.low);
        const pUpperShadow = +peakCandle.high - Math.max(+peakCandle.open, +peakCandle.close);
        if (pUpperShadow / pRange >= 0.20 || pUpperShadow >= 15) {
          hadFirstRejection = true;
        }
      }
      for (let i = peakIndex; i < lookbackCandles.length; i++) {
        const c = lookbackCandles[i];
        if (+c.close < +c.open || +c.close < peakHigh * 0.999) {
          hadFirstRejection = true;
          break;
        }
      }

      // 条件3：前一根K线为弱势反弹或小实体停顿（非强劲单边大阴线瀑布）
      // - 阳线弱反弹：prevClose >= prevOpen
      // - 或停顿十字星/小实体：prevBody <= Math.max(currBody * 0.7, 30)
      const isPrevWeakBounce = prevClose >= prevOpen;
      const isPrevSmallPause = prevBody <= Math.max(currBody * 0.7, 30) || prevBody <= currClose * 0.0004;
      const isPauseOrBounce = (isPrevWeakBounce || isPrevSmallPause) && prevHigh <= peakHigh * 1.0008;

      // 条件4：阴线二次反包确认 (Secondary Engulfing)
      // 当前阴线收盘跌破前阳开盘价，或跌破前K线低点/实体
      const isEngulfingPrev =
        (prevClose >= prevOpen && currClose <= prevOpen) ||
        (currClose <= prevLow && currClose < prevClose) ||
        (currClose <= Math.min(prevOpen, prevClose) && currBody >= prevBody * 0.8);

      if (hasElevatedPeak && hadFirstRejection && isPauseOrBounce && isEngulfingPrev) {
        let confidence = 85;
        const details: string[] = [];

        // 加分项1：双顶/多次测顶无力突破（M顶结构）
        const retestCount = lookbackCandles.filter(k => +k.high >= peakHigh * 0.9988).length;
        if (retestCount >= 2) {
          confidence += 5;
          details.push('双顶/多次测顶承压');
        }

        // 加分项2：实体坚决且彻底跌破前K线低点
        if (currClose < prevLow && currBody > prevBody * 1.2) {
          confidence += 5;
          details.push('大阴破底击穿支撑');
        }

        confidence = Math.min(95, confidence);
        const detailStr = details.length > 0 ? `(${details.join('｜')})` : '';
        const reason = `反转策略: 上涨趋势阴线二次反包做空｜波段冲高(${peakHigh.toFixed(0)})受阻后弱反弹无力破高，关键大阴线二次反包确认见顶${detailStr}｜置信度${confidence}%`;

        return {
          direction: 'DOWN',
          confidence,
          reason
        };
      }
    }

    // -------------------------------------------------------------------------
    // B. 反转策略：下跌趋势，阳线二次反包做多 (Bottom Reversal LONG - 底部对称形态)
    // -------------------------------------------------------------------------
    const isCurrBullish = currClose > currOpen && currBody >= minBody;

    if (isCurrBullish) {
      const troughLow = Math.min(...lookbackCandles.map(k => +k.low));
      const troughCandle = lookbackCandles.find(k => +k.low === troughLow);
      const troughIndex = lookbackCandles.findIndex(k => +k.low === troughLow);

      // 下跌趋势背景判定：严格定义为 EMA50 < EMA200 且斜率差不多一样平行向下
      const isDowntrendContext = (ema50Values && ema200Values)
        ? this.isParallelEmaTrend(ema50Values, ema200Values, 'DOWN')
        : (indicators.ema50 < indicators.ema200);

      // 条件1：当前处于波段探底之后（最低谷值至少比当前收盘低出0.20%以上）
      const hasDepressedTrough = isDowntrendContext && (troughLow <= currClose * 0.9980);

      // 条件2：探底后有初次企稳表现（探底K线留有下影线>=20%或长下影>=15点，或者探底后收过阳线反弹）
      let hadFirstStabilization = false;
      if (troughCandle) {
        const tRange = Math.max(1, +troughCandle.high - +troughCandle.low);
        const tLowerShadow = Math.min(+troughCandle.open, +troughCandle.close) - +troughCandle.low;
        if (tLowerShadow / tRange >= 0.20 || tLowerShadow >= 15) {
          hadFirstStabilization = true;
        }
      }
      for (let i = troughIndex; i < lookbackCandles.length; i++) {
        const c = lookbackCandles[i];
        if (+c.close > +c.open || +c.close > troughLow * 1.001) {
          hadFirstStabilization = true;
          break;
        }
      }

      // 条件3：前一根K线为弱势下探或小实体停顿
      // - 阴线弱下探：prevClose <= prevOpen
      // - 或停顿十字星/小实体：prevBody <= Math.max(currBody * 0.7, 30)
      const isPrevWeakPullback = prevClose <= prevOpen;
      const isPrevSmallPause = prevBody <= Math.max(currBody * 0.7, 30) || prevBody <= currClose * 0.0004;
      const isPauseOrPullback = (isPrevWeakPullback || isPrevSmallPause) && prevLow >= troughLow * 0.9992;

      // 条件4：阳线二次反包确认 (Secondary Engulfing)
      const isEngulfingPrev =
        (prevClose <= prevOpen && currClose >= prevOpen) ||
        (currClose >= prevHigh && currClose > prevClose) ||
        (currClose >= Math.max(prevOpen, prevClose) && currBody >= prevBody * 0.8);

      if (hasDepressedTrough && hadFirstStabilization && isPauseOrPullback && isEngulfingPrev) {
        let confidence = 85;
        const details: string[] = [];

        // 加分项1：双底/多次测底企稳（W底结构）
        const retestCount = lookbackCandles.filter(k => +k.low <= troughLow * 1.0012).length;
        if (retestCount >= 2) {
          confidence += 5;
          details.push('双底/多次测底企稳');
        }

        // 加分项2：实体坚决且彻底突破前K线高点
        if (currClose > prevHigh && currBody > prevBody * 1.2) {
          confidence += 5;
          details.push('大阳破顶反包上攻');
        }

        confidence = Math.min(95, confidence);
        const detailStr = details.length > 0 ? `(${details.join('｜')})` : '';
        const reason = `反转策略: 下跌趋势阳线二次反包做多｜波段探底(${troughLow.toFixed(0)})企稳后弱下探无力破低，关键大阳线二次反包确认筑底${detailStr}｜置信度${confidence}%`;

        return {
          direction: 'UP',
          confidence,
          reason
        };
      }
    }

    return null;
  }

  private determineTrend(ema50: number, ema150: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (ema50 > ema150) return 'BULLISH';
    if (ema50 < ema150) return 'BEARISH';
    return 'NEUTRAL';
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;

    return Math.sqrt(variance);
  }

  // 上影线不能大过实体 或者上影线不能大于下影线
  private isUpperShadowTooLarge(kline: IPriceData): boolean {
    const bodySize = Math.abs(kline.close - kline.open);
    // 计算上影线长度
    const upperShadow = kline.high - Math.max(kline.open, kline.close);
    // 计算下影线长度
    const lowerShadow = Math.min(kline.open, kline.close) - kline.low;

    // 检查两个条件：上影线大过实体 或者 上影线大于下影线
    return upperShadow > bodySize || upperShadow > lowerShadow;
  }

  // 下影线不能大过实体 或者下影线不能大于上影线
  private isLowerShadowTooLarge(kline: IPriceData): boolean {
    const bodySize = Math.abs(kline.close - kline.open);
    // 计算上影线长度
    const upperShadow = kline.high - Math.max(kline.open, kline.close);
    // 计算下影线长度
    const lowerShadow = Math.min(kline.open, kline.close) - kline.low;

    // 检查两个条件：下影线大过实体 或者 下影线大于上影线
    return lowerShadow > bodySize || lowerShadow > upperShadow;
  }

  /**
   * 计算EMA序列
   */
  private calculateEma(prices: number[], period: number): number[] {
    return ti.ema({ values: prices, period }).map(v => +v);
  }

  /**
   * 判断EMA50与EMA200是否处于平行趋势
   * 用户定义：
   * 上涨趋势：EMA50 > EMA200，且两条均线都向上、斜率差不多一样（走势平行，间距相对稳定）
   * 下降趋势：EMA50 < EMA200，且两条均线都向下、斜率差不多一样（走势平行，间距相对稳定）
   */
  public isParallelEmaTrend(ema50Values: number[], ema200Values: number[], direction: 'UP' | 'DOWN'): boolean {
    if (!ema50Values || !ema200Values) return false;
    // 回看12根5分钟K线（即最近1小时）
    const lookback = Math.min(12, ema200Values.length - 1);
    if (lookback < 5) return false;

    const ema50Recent = ema50Values.slice(-(lookback + 1));
    const ema200Recent = ema200Values.slice(-(lookback + 1));

    const curEma50 = ema50Recent[ema50Recent.length - 1];
    const curEma200 = ema200Recent[ema200Recent.length - 1];

    // 计算1小时相对起点百分比斜率
    const slope50 = (curEma50 - ema50Recent[0]) / ema50Recent[0];
    const slope200 = (curEma200 - ema200Recent[0]) / ema200Recent[0];

    // 最小倾斜度门槛（1小时内至少变动 0.02%，过滤无序微动横盘）
    const minSlope = 0.0002;

    if (direction === 'UP') {
      // 1. 均线高低关系：EMA50 > EMA200
      if (curEma50 <= curEma200) return false;
      // 2. 两条均线都向上倾斜
      if (slope50 < minSlope || slope200 <= 0) return false;
    } else {
      // 1. 均线高低关系：EMA50 < EMA200
      if (curEma50 >= curEma200) return false;
      // 2. 两条均线都向下倾斜
      if (slope50 > -minSlope || slope200 >= 0) return false;
    }

    // 3. 斜率差不多一样：
    // a) 斜率比例：slope50 与 slope200 比值在合理范围（0.5 ~ 2.0 倍），不能一个陡峭一个走平
    const ratio = slope200 !== 0 ? Math.abs(slope50 / slope200) : 1;
    if (ratio < 0.5 || ratio > 2.0) return false;

    // b) 走势平行：间距保持稳定，间距波动不超过均值的 20%
    const spreads = ema50Recent.map((v, i) => Math.abs(v - ema200Recent[i]));
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    if (avgSpread <= 0) return false;

    return spreads.every(spread => Math.abs(spread - avgSpread) / avgSpread <= 0.20);
  }

  /**
   * 判断K线是否上穿均线：当前收盘站上均线，且开盘在均线下方或前一根收盘在均线下方
   */
  private crossesAboveMa(current: any, previous: any, ma: number): boolean {
    const curOpen = +current.open;
    const curClose = +current.close;
    const prevClose = +previous.close;
    return curClose > ma && (curOpen <= ma || prevClose <= ma);
  }

  /**
   * 判断K线是否在均线处受阻：收盘落回均线下方。
   * 最高价触及均线，或距离均线不超过 0.02%；开盘、前一根收盘在均线上方也算。
   */
  private crossesBelowMa(current: any, previous: any, ma: number): boolean {
    const curOpen = +current.open;
    const curHigh = +current.high;
    const curClose = +current.close;
    const prevClose = +previous.close;
    const highReachesMa = curHigh >= ma * (1 - 0.0002);
    return curClose < ma && (highReachesMa || curOpen >= ma || prevClose >= ma);
  }

  /**
   * 趋势策略：EMA50/EMA200平行趋势中，回踩均线后出现关键K线
   * 上升趋势：回踩EMA50或EMA200后，阳线上穿均线且反包前一根阴线（或实体大于前一根阴线实体的1/2），收线后进场做多
   * 下降趋势：反弹EMA50或EMA200后，阴线下穿均线且反包前一根阳线（或实体大于前一根阳线实体的1/2），收线后进场做空
   */
  private detectEma200TrendPullbackStrategy(fiveMinuteKlines: any[]): { direction: 'UP' | 'DOWN'; reasoning: string } | null {
    if (!fiveMinuteKlines || fiveMinuteKlines.length < 3) return null;

    const prices = fiveMinuteKlines.map(k => +k.close);
    const ema50Values = this.calculateEma(prices, this.EMA50_PERIOD);
    const ema200Values = this.calculateEma(prices, this.EMA200_PERIOD);

    if (ema200Values.length < 10) {
      console.log('趋势策略: EMA200数据不足，跳过');
      return null;
    }

    const ema50 = ema50Values[ema50Values.length - 1];
    const ema200 = ema200Values[ema200Values.length - 1];

    const current = fiveMinuteKlines[fiveMinuteKlines.length - 1];
    const previous = fiveMinuteKlines[fiveMinuteKlines.length - 2];

    const curOpen = +current.open;
    const curClose = +current.close;
    const curBody = Math.abs(curClose - curOpen);
    const prevOpen = +previous.open;
    const prevClose = +previous.close;
    const prevBody = Math.abs(prevClose - prevOpen);

    // 上升趋势：ema50 > ema200 且走势平行
    if (ema50 > ema200 && this.isParallelEmaTrend(ema50Values, ema200Values, 'UP')) {
      const isPrevBearish = prevClose < prevOpen; // 前一根阴线
      const isCurBullish = curClose > curOpen;    // 当前阳线
      const crossedAbove = this.crossesAboveMa(current, previous, ema50) || this.crossesAboveMa(current, previous, ema200);
      const engulfsPrev = curClose >= prevOpen;    // 反包前一根阴线
      const bodyGreaterThanHalf = curBody > prevBody * 0.5; // 实体大于前一根阴线实体的1/2

      if (isPrevBearish && isCurBullish && crossedAbove && (engulfsPrev || bodyGreaterThanHalf)) {
        const crossedMa = this.crossesAboveMa(current, previous, ema50) ? 'EMA50' : 'EMA200';
        return {
          direction: 'UP',
          reasoning: `趋势策略: EMA50/200平行上升，回踩${crossedMa}${engulfsPrev ? '反包' : '半包'}做多`
        };
      }
    }

    // 下降趋势：ema50 < ema200 且走势平行
    if (ema50 < ema200 && this.isParallelEmaTrend(ema50Values, ema200Values, 'DOWN')) {
      const isPrevBullish = prevClose > prevOpen; // 前一根阳线
      const isCurBearish = curClose < curOpen;    // 当前阴线
      const crossedBelow = this.crossesBelowMa(current, previous, ema50) || this.crossesBelowMa(current, previous, ema200);
      const engulfsPrev = curClose <= prevOpen;    // 反包前一根阳线
      const bodyGreaterThanHalf = curBody > prevBody * 0.5; // 实体大于前一根阳线实体的1/2

      if (isPrevBullish && isCurBearish && crossedBelow && (engulfsPrev || bodyGreaterThanHalf)) {
        const crossedMa = this.crossesBelowMa(current, previous, ema50) ? 'EMA50' : 'EMA200';
        return {
          direction: 'DOWN',
          reasoning: `趋势策略: EMA50/200平行下降，反弹${crossedMa}${engulfsPrev ? '反包' : '半包'}做空`
        };
      }
    }

    return null;
  }

  /**
   * 10分钟高胜率BTC策略（基于SMC理念）
   */
  async generate10MinuteSignal(priceHistory: IPriceData[], tenMinuteKlines: any[]): Promise<{ direction: 'UP' | 'DOWN', confidence: number, reasoning: string[] } | null> {
    try {
      if (!this.STRATEGIES_ENABLED) {
        console.log('全部策略已下线，不产生10分钟信号');
        return null;
      }

      // 检查参数是否存在
      if (!tenMinuteKlines || !Array.isArray(tenMinuteKlines)) {
        console.log('10分钟K线数据不存在');
        return null;
      }

      // 确保有足够的10分钟K线数据
      if (tenMinuteKlines.length < 10) {
        console.log('10分钟K线数据不足，需要至少10个数据点');
        return null;
      }

      // 计算技术指标
      const indicators = await this.calculateIndicators(priceHistory, tenMinuteKlines);
      const lastKline = tenMinuteKlines[tenMinuteKlines.length - 1];
      const currentPrice = +lastKline.close;

      // 趋势判断
      const trend = this.determineMarketStructure(tenMinuteKlines);
      console.log('市场结构:', trend);

      // 订单块识别
      const orderBlocks = this.identifyOrderBlocks(tenMinuteKlines);
      console.log('识别到的订单块数量:', orderBlocks.length);

      // 流动性分析
      const liquidityZones = this.identifyLiquidityZones(tenMinuteKlines);
      console.log('识别到的流动性区域数量:', liquidityZones.length);

      let score = 0;
      const reasoning: string[] = [];

      // 多头入场条件
      if (trend === 'BULLISH' || trend === 'RANGE_BREAKUP') {
        // 寻找最近的看涨订单块
        const bullishOrderBlock = this.findLatestBullishOrderBlock(orderBlocks);
        if (bullishOrderBlock && this.isPriceInOrderBlock(currentPrice, bullishOrderBlock)) {
          // 检查技术指标
          if (currentPrice > indicators.ema50) {
            // 检查K线形态
            if (this.isBullishReversalPattern(lastKline)) {
              score += 90;
              reasoning.push(`SMC策略: 上涨趋势+看涨订单块+技术指标共振，进场做多`);
            }
          }
        }
      }

      // 空头入场条件
      if (trend === 'BEARISH' || trend === 'RANGE_BREAKDOWN') {
        // 寻找最近的看跌订单块
        const bearishOrderBlock = this.findLatestBearishOrderBlock(orderBlocks);
        if (bearishOrderBlock && this.isPriceInOrderBlock(currentPrice, bearishOrderBlock)) {
          // 检查技术指标
          if (currentPrice < indicators.ema50) {
            // 检查K线形态
            if (this.isBearishReversalPattern(lastKline)) {
              score -= 90;
              reasoning.push(`SMC策略: 下跌趋势+看跌订单块+技术指标共振，进场做空`);
            }
          }
        }
      }

      // 信号过滤
      if (Math.abs(score) < 80) {
        console.log('信号强度不足，跳过');
        return null;
      }

      // 确定趋势方向
      const direction = score > 0 ? 'UP' : 'DOWN';
      const confidence = Math.min(Math.abs(score), 100);

      return {
        direction,
        confidence,
        reasoning
      };
    } catch (error) {
      console.error('生成10分钟信号时出错:', error);
      return null;
    }
  }

  /**
   * 识别市场结构
   */
  private determineMarketStructure(klines: any[]): 'BULLISH' | 'BEARISH' | 'RANGE' | 'RANGE_BREAKUP' | 'RANGE_BREAKDOWN' {
    if (klines.length < 5) {
      return 'RANGE';
    }

    // 提取最近5根K线的收盘价
    const closes = klines.slice(-5).map(k => +k.close);

    // 计算高点和低点
    const highs = klines.slice(-5).map(k => +k.high);
    const lows = klines.slice(-5).map(k => +k.low);

    // 上涨趋势：更高的高点和更高的低点
    const higherHighs = highs[4] > highs[3] && highs[3] > highs[2] && highs[2] > highs[1] && highs[1] > highs[0];
    const higherLows = lows[4] > lows[3] && lows[3] > lows[2] && lows[2] > lows[1] && lows[1] > lows[0];

    // 下跌趋势：更低的低点和更低的高点
    const lowerLows = lows[4] < lows[3] && lows[3] < lows[2] && lows[2] < lows[1] && lows[1] < lows[0];
    const lowerHighs = highs[4] < highs[3] && highs[3] < highs[2] && highs[2] < highs[1] && highs[1] < highs[0];

    if (higherHighs && higherLows) {
      return 'BULLISH';
    } else if (lowerLows && lowerHighs) {
      return 'BEARISH';
    } else {
      // 检查是否突破
      const recentHighs = highs.slice(-3);
      const recentLows = lows.slice(-3);
      const previousHighs = highs.slice(-6, -3);
      const previousLows = lows.slice(-6, -3);

      if (previousHighs.length > 0 && Math.max(...recentHighs) > Math.max(...previousHighs)) {
        return 'RANGE_BREAKUP';
      } else if (previousLows.length > 0 && Math.min(...recentLows) < Math.min(...previousLows)) {
        return 'RANGE_BREAKDOWN';
      } else {
        return 'RANGE';
      }
    }
  }

  /**
   * 识别订单块
   */
  private identifyOrderBlocks(klines: any[]): any[] {
    const orderBlocks: any[] = [];

    for (let i = 1; i < klines.length; i++) {
      const current = klines[i];
      const previous = klines[i - 1];

      // 看涨订单块：大阳线，实体大于上影线
      if (+current.close > +current.open &&
        (+current.close - +current.open) > (current.high - +current.close) &&
        +current.close > +previous.close) {
        orderBlocks.push({
          type: 'BULLISH',
          startTime: current.openTime,
          endTime: current.closeTime,
          high: current.high,
          low: current.low,
          open: +current.open,
          close: +current.close,
          bodySize: +current.close - +current.open
        });
      }

      // 看跌订单块：大阴线，实体大于下影线
      if (+current.close < +current.open &&
        (+current.open - +current.close) > (+current.close - current.low) &&
        +current.close < +previous.close) {
        orderBlocks.push({
          type: 'BEARISH',
          startTime: current.openTime,
          endTime: current.closeTime,
          high: current.high,
          low: current.low,
          open: +current.open,
          close: +current.close,
          bodySize: +current.open - +current.close
        });
      }
    }

    return orderBlocks;
  }

  /**
   * 识别流动性区域
   */
  private identifyLiquidityZones(klines: any[]): any[] {
    const liquidityZones: any[] = [];

    // 寻找密集成交区域
    for (let i = 2; i < klines.length - 2; i++) {
      const current = klines[i];
      const previous = klines[i - 1];
      const next = klines[i + 1];

      // 识别高流动性区域：价格在小范围内震荡，成交量放大
      const priceRange = current.high - current.low;
      const avgPriceRange = (klines.slice(i - 2, i + 3).reduce((sum, k) => sum + (k.high - k.low), 0) / 5);

      if (priceRange < avgPriceRange * 0.6) {
        // 价格波动小，可能是流动性区域
        const volume = +current.volume;
        const avgVolume = klines.slice(i - 2, i + 3).reduce((sum, k) => sum + +k.volume, 0) / 5;

        if (volume > avgVolume * 1.2) {
          // 成交量放大，确认流动性区域
          liquidityZones.push({
            startTime: current.openTime,
            endTime: current.closeTime,
            high: current.high,
            low: current.low,
            volume: volume
          });
        }
      }
    }

    return liquidityZones;
  }

  /**
   * 寻找最近的看涨订单块
   */
  private findLatestBullishOrderBlock(orderBlocks: any[]): any | null {
    return orderBlocks.filter(block => block.type === 'BULLISH').pop() || null;
  }

  /**
   * 寻找最近的看跌订单块
   */
  private findLatestBearishOrderBlock(orderBlocks: any[]): any | null {
    return orderBlocks.filter(block => block.type === 'BEARISH').pop() || null;
  }

  /**
   * 检查价格是否在订单块范围内
   */
  private isPriceInOrderBlock(price: number, orderBlock: any): boolean {
    if (orderBlock.type === 'BULLISH') {
      return price >= orderBlock.low && price <= orderBlock.open;
    } else {
      return price <= orderBlock.high && price >= orderBlock.open;
    }
  }

  /**
   * 检查是否为看涨反转K线形态
   */
  private isBullishReversalPattern(kline: any): boolean {
    const open = +kline.open;
    const close = +kline.close;
    const high = kline.high;
    const low = kline.low;

    // 锤子线
    if (close > open && (close - open) > (high - close) && (open - low) > 2 * (close - open)) {
      return true;
    }

    // 吞没形态（需要前一根K线）
    // 这里简化处理，实际需要对比前一根K线
    if (close > open && (close - open) > (high - close) && (close - open) > (open - low)) {
      return true;
    }

    return false;
  }

  /**
   * 检查是否为看跌反转K线形态
   */
  private isBearishReversalPattern(kline: any): boolean {
    const open = +kline.open;
    const close = +kline.close;
    const high = kline.high;
    const low = kline.low;

    // 流星线
    if (close < open && (open - close) > (close - low) && (high - open) > 2 * (open - close)) {
      return true;
    }

    // 看跌吞没形态（需要前一根K线）
    // 这里简化处理，实际需要对比前一根K线
    if (close < open && (open - close) > (close - low) && (open - close) > (high - open)) {
      return true;
    }

    return false;
  }
}