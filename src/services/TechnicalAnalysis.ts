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
     * 1. 反转策略：5分钟周期 6连涨做空、6连跌做多（无振幅过滤）
     */
    if (!this.isFiveMinuteUsed && fiveMinuteKlines.length >= 6) {
      const recentSixCandles = fiveMinuteKlines.slice(-6); // 最近6根K线

      // 计算最近6根K线中的最高价和最低价
      const highestHigh = Math.max(...recentSixCandles.map(k => k.high));
      const lowestLow = Math.min(...recentSixCandles.map(k => k.low));
      const priceRange = highestHigh - lowestLow;

      console.log(`最近6根K线: 最高价=${highestHigh.toFixed(2)}, 最低价=${lowestLow.toFixed(2)}, 价差=${priceRange.toFixed(2)}`);

      const is6ConsecutiveDown = this.checkConsecutiveTrend(recentSixCandles, 'DOWN', 6);
      const is6ConsecutiveUp = this.checkConsecutiveTrend(recentSixCandles, 'UP', 6);

      // 6连跌：直接做多
      if (is6ConsecutiveDown) {
        score = 100;
        reasoning.push(`反转策略: 6连跌做多｜价差${priceRange.toFixed(0)}点`);
      }

      // 6连涨：直接做空
      if (is6ConsecutiveUp) {
        score = -100;
        reasoning.push(`反转策略: 6连涨做空｜价差${priceRange.toFixed(0)}点`);
      }
    }

    /**
     * 2. 趋势做多策略（红框K线形态）：
     * - 上涨趋势：EMA50 > EMA200
     * - 形态识别：阴线回调后收出关键反包阳线（阳线收盘反包阴线开盘价，或实体强反转刺透）
     * - 置信度规则：越靠近均线（EMA50或EMA200），置信度越高
     */
    if (!this.isFiveMinuteUsed && score === 0 && fiveMinuteKlines.length >= 2) {
      const isUptrend = indicators.ema50 > indicators.ema200;
      if (isUptrend) {
        const prevKline = fiveMinuteKlines[fiveMinuteKlines.length - 2];
        const currKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];

        const prevOpen = +prevKline.open;
        const prevClose = +prevKline.close;
        const currOpen = +currKline.open;
        const currClose = +currKline.close;
        const currLow = +currKline.low;
        const currHigh = +currKline.high;
        const prevLow = +prevKline.low;
        const prevHigh = +prevKline.high;

        const isPrevBearish = prevClose < prevOpen;
        const isCurrBullish = currClose > currOpen;

        const prevBody = Math.abs(prevOpen - prevClose);
        const currBody = Math.abs(currClose - currOpen);

        // 形态判断：前阴后阳，且阳线收盘反包阴线开盘价，或实体覆盖前阴80%以上且收在前阴中点上方
        const isEngulfing = currClose >= prevOpen;
        const isStrongPiercing = currClose > (prevOpen + prevClose) / 2 && currBody >= prevBody * 0.8 && currClose > prevClose;

        if (isPrevBearish && isCurrBullish && (isEngulfing || isStrongPiercing)) {
          const ema50 = indicators.ema50;
          const ema200 = indicators.ema200;

          // 检查这两根K线是否触碰或包含 EMA50 或 EMA200
          const minLow = Math.min(prevLow, currLow);
          const maxHigh = Math.max(prevHigh, currHigh);

          const touchesEma50 = minLow <= ema50 && maxHigh >= ema50;
          const touchesEma200 = minLow <= ema200 && maxHigh >= ema200;

          let confidence = 70;
          let maTag = '';

          if (touchesEma50 || touchesEma200) {
            // 直接踩在均线上，赋予最高置信度 95%
            confidence = 95;
            maTag = touchesEma50 ? '回踩EMA50(踩线)' : '回踩EMA200(踩线)';
          } else {
            // 未直接触线，计算距离 EMA50 或 EMA200 的最近距离百分比
            const distEma50Pct = (Math.abs(currClose - ema50) / ema50) * 100;
            const distEma200Pct = (Math.abs(currClose - ema200) / ema200) * 100;

            const isNear50 = distEma50Pct <= distEma200Pct;
            const minDistPct = isNear50 ? distEma50Pct : distEma200Pct;
            const targetMa = isNear50 ? 'EMA50' : 'EMA200';

            // 越靠近均线置信度越高（梯度：90% -> 85% -> 80% -> 75% -> 70%）
            if (minDistPct <= 0.15) {
              confidence = 90;
            } else if (minDistPct <= 0.35) {
              confidence = 85;
            } else if (minDistPct <= 0.65) {
              confidence = 80;
            } else if (minDistPct <= 1.0) {
              confidence = 75;
            } else {
              confidence = 70;
            }

            maTag = `距${targetMa} ${minDistPct.toFixed(2)}%`;
          }

          score = confidence;
          let maTagReason = maTag;

          // 检查是否遭遇前高阻力
          const resistanceCheck = this.checkResistanceForLong(fiveMinuteKlines, currKline, prevKline, ema50);
          if (resistanceCheck.isResisted) {
            const oldConf = confidence;
            // 遭遇前高阻力降低置信度（扣减20%且上限截断在75%，确保低于80%阈值不操作）
            confidence = Math.min(Math.max(50, confidence - 20), 75);
            maTagReason += `｜${resistanceCheck.reason}｜置信度由${oldConf}%调降至${confidence}%(低于80%不操作)`;
            score = confidence;
          }

          reasoning.push(`趋势策略: EMA多头回踩反包做多｜${maTagReason}｜置信度${confidence}%`);
        }
      }
    }

    /**
     * 3. 趋势做空策略（下跌趋势镜像）：
     * - 下跌趋势：EMA50 < EMA200
     * - 形态识别：阳线反弹后收出关键反包阴线（阴线收盘跌破阳线开盘价，或实体强反转刺透）
     * - 置信度规则：越靠近均线（EMA50或EMA200），置信度越高
     */
    if (!this.isFiveMinuteUsed && score === 0 && fiveMinuteKlines.length >= 2) {
      const isDowntrend = indicators.ema50 < indicators.ema200;
      if (isDowntrend) {
        const prevKline = fiveMinuteKlines[fiveMinuteKlines.length - 2];
        const currKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];

        const prevOpen = +prevKline.open;
        const prevClose = +prevKline.close;
        const currOpen = +currKline.open;
        const currClose = +currKline.close;
        const currLow = +currKline.low;
        const currHigh = +currKline.high;
        const prevLow = +prevKline.low;
        const prevHigh = +prevKline.high;

        const isPrevBullish = prevClose > prevOpen; // 前一根为阳线反弹
        const isCurrBearish = currClose < currOpen; // 当前根为阴线下杀

        const prevBody = Math.abs(prevClose - prevOpen);
        const currBody = Math.abs(currClose - currOpen);

        // 形态判断：前阳后阴，且阴线收盘跌破阳线开盘价，或实体覆盖前阳80%以上且收在前阳中点下方
        const isEngulfing = currClose <= prevOpen;
        const isStrongPiercing = currClose < (prevOpen + prevClose) / 2 && currBody >= prevBody * 0.8 && currClose < prevClose;

        if (isPrevBullish && isCurrBearish && (isEngulfing || isStrongPiercing)) {
          const ema50 = indicators.ema50;
          const ema200 = indicators.ema200;

          // 检查这两根K线是否触碰或包含 EMA50 或 EMA200
          const minLow = Math.min(prevLow, currLow);
          const maxHigh = Math.max(prevHigh, currHigh);

          const touchesEma50 = minLow <= ema50 && maxHigh >= ema50;
          const touchesEma200 = minLow <= ema200 && maxHigh >= ema200;

          let confidence = 70;
          let maTag = '';

          if (touchesEma50 || touchesEma200) {
            // 直接触碰或受阻于均线，赋予最高置信度 95%
            confidence = 95;
            maTag = touchesEma50 ? '反弹EMA50(碰线)' : '反弹EMA200(碰线)';
          } else {
            // 未直接触线，计算距离 EMA50 或 EMA200 的最近距离百分比
            const distEma50Pct = (Math.abs(currClose - ema50) / ema50) * 100;
            const distEma200Pct = (Math.abs(currClose - ema200) / ema200) * 100;

            const isNear50 = distEma50Pct <= distEma200Pct;
            const minDistPct = isNear50 ? distEma50Pct : distEma200Pct;
            const targetMa = isNear50 ? 'EMA50' : 'EMA200';

            // 越靠近均线置信度越高（梯度：90% -> 85% -> 80% -> 75% -> 70%）
            if (minDistPct <= 0.15) {
              confidence = 90;
            } else if (minDistPct <= 0.35) {
              confidence = 85;
            } else if (minDistPct <= 0.65) {
              confidence = 80;
            } else if (minDistPct <= 1.0) {
              confidence = 75;
            } else {
              confidence = 70;
            }

            maTag = `距${targetMa} ${minDistPct.toFixed(2)}%`;
          }

          score = -confidence;
          let maTagReason = maTag;

          // 检查是否遭遇前低支撑
          const supportCheck = this.checkSupportForShort(fiveMinuteKlines, currKline, prevKline, ema50);
          if (supportCheck.isSupported) {
            const oldConf = confidence;
            // 遭遇前低支撑降低置信度（扣减20%且上限截断在75%，确保低于80%阈值不操作）
            confidence = Math.min(Math.max(50, confidence - 20), 75);
            maTagReason += `｜${supportCheck.reason}｜置信度由${oldConf}%调降至${confidence}%(低于80%不操作)`;
            score = -confidence;
          }

          reasoning.push(`趋势策略: EMA空头反弹反包做空｜${maTagReason}｜置信度${confidence}%`);
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

    // 回看最近 5~50 根K线（在当前回调反包之前的高点）
    const startIndex = Math.max(0, fiveMinuteKlines.length - 50);
    const endIndex = fiveMinuteKlines.length - 2; // 排除当前K线和前一根回调K线
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

    // 去重并过滤出高于当前回调低点且高于当前开盘价的有效阻力位
    const uniqueLevels = Array.from(new Set(candidateLevels));
    const validLevels = uniqueLevels.filter(lvl =>
      lvl > pullbackLow + (currClose * 0.001) && lvl >= currOpen
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

    // 回看最近 5~50 根K线（在当前反弹反包之前的低点）
    const startIndex = Math.max(0, fiveMinuteKlines.length - 50);
    const endIndex = fiveMinuteKlines.length - 2;
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

    // 去重并过滤出低于当前反弹高点且低于当前开盘价的有效支撑位
    const uniqueLevels = Array.from(new Set(candidateLevels));
    const validLevels = uniqueLevels.filter(lvl =>
      lvl < bounceHigh - (currClose * 0.001) && lvl <= currOpen
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

  /**
   * 检查是否是连续趋势
   * 6连涨：必须是阳线（收盘价 > 开盘价）且收盘价连续上涨
   * 6连跌：必须是阴线（收盘价 < 开盘价）且收盘价连续下跌
   */
  private checkConsecutiveTrend(candles: any[], direction: 'UP' | 'DOWN', targetCount: number = 6): boolean {
    if (candles.length < targetCount) return false;

    for (let i = 0; i < candles.length; i++) {
      const currentCandle = candles[i];
      const currentClose = +currentCandle.close;
      const currentOpen = +currentCandle.open;

      if (direction === 'UP') {
        // 连涨：必须是阳线（收盘价 > 开盘价）
        if (currentClose <= currentOpen) {
          return false;
        }

        // 检查收盘价是否连续上涨（从第2根开始比较）
        if (i > 0) {
          const previousCandle = candles[i - 1];
          if (currentClose <= +previousCandle.close) {
            return false;
          }
        }
      } else {
        // 连跌：必须是阴线（收盘价 < 开盘价）
        if (currentClose >= currentOpen) {
          return false;
        }

        // 检查收盘价是否连续下跌（从第2根开始比较）
        if (i > 0) {
          const previousCandle = candles[i - 1];
          if (currentClose >= +previousCandle.close) {
            return false;
          }
        }
      }
    }

    return true;
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
   * 上升趋势：ema50 > ema200，且两条均线都向上、走势平行（间距稳定）
   * 下降趋势：ema50 < ema200，且两条均线都向下、走势平行（间距稳定）
   */
  private isParallelEmaTrend(ema50Values: number[], ema200Values: number[], direction: 'UP' | 'DOWN'): boolean {
    const lookback = Math.min(20, ema200Values.length - 1);
    if (lookback < 5) return false;

    const ema50Recent = ema50Values.slice(-(lookback + 1));
    const ema200Recent = ema200Values.slice(-(lookback + 1));

    // 趋势方向确认：近端相对于远端
    if (direction === 'UP') {
      // 两条均线都需上行
      if (ema50Recent[ema50Recent.length - 1] <= ema50Recent[0]) return false;
      if (ema200Recent[ema200Recent.length - 1] <= ema200Recent[0]) return false;
    } else {
      // 两条均线都需下行
      if (ema50Recent[ema50Recent.length - 1] >= ema50Recent[0]) return false;
      if (ema200Recent[ema200Recent.length - 1] >= ema200Recent[0]) return false;
    }

    // 走势平行：EMA50与EMA200的间距保持稳定
    const spreads = ema50Recent.map((v, i) => Math.abs(v - ema200Recent[i]));
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    if (avgSpread <= 0) return false;

    // 间距波动不超过均值的20%
    return spreads.every(spread => Math.abs(spread - avgSpread) / avgSpread <= 0.2);
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
   * 判断K线是否下穿均线：当前收盘跌破均线，且开盘在均线上方或前一根收盘在均线上方
   */
  private crossesBelowMa(current: any, previous: any, ma: number): boolean {
    const curOpen = +current.open;
    const curClose = +current.close;
    const prevClose = +previous.close;
    return curClose < ma && (curOpen >= ma || prevClose >= ma);
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