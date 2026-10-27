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

    // 判断5分钟K线主要趋势方向
    const isBullishTrend = indicators.ema50 > indicators.ema150;
    const isBearishTrend = indicators.ema50 < indicators.ema150;

    // 寻找回调入场机会（动态EMA50缓冲区，BTC在80,000点附近时约为35-50点，适配波动率）
    const ema50Range = Math.max(30, this.lastFiveMinuteClosePrice * 0.0005);

    console.log('isBullishTrend:', isBullishTrend);
    console.log('ema50:', indicators.ema50);
    console.log('ema150:', indicators.ema150);
    console.log('ema50Range:', ema50Range);

    /**
     * 策略体系（基于89笔实盘验证优化）：
     * 1. EMA50回踩/反弹顺势（胜率76.9%）—— 仅EMA50，已下线EMA150（胜率33%）
     * 2. 5连跌超跌反弹做多（胜率68.4%，价差≥120）—— 已下线5连涨猜顶（胜率36.7%）
     * 3. 偏离EMA50超1.2%均值回归（胜率100%）
     * 4. 同向10分钟持仓互斥（TradingSignal.ts），防连续吃损
     */
    if (isBullishTrend) {
      if (!this.isFiveMinuteUsed) {
        // 上涨趋势中寻找EMA50回调做多机会
        // 条件：收盘价在EMA50上方指定范围内且没有长上影线
        if (this.lastFiveMinuteClosePrice >= indicators.ema50 &&
          this.lastFiveMinuteClosePrice <= indicators.ema50 + ema50Range &&
          !this.isUpperShadowTooLarge(lastFiveKline)) {
          score += 80;
          reasoning.push(`趋势策略: 多头回踩EMA50做多｜收盘${this.lastFiveMinuteClosePrice.toFixed(0)} ≈ EMA50 ${indicators.ema50.toFixed(0)}`);
        }
        // 注意：EMA150深幅回调在实盘表现为破位下跌（胜率仅33%），已下线
      }
    } else if (isBearishTrend) {
      if (!this.isFiveMinuteUsed) {
        // 下跌趋势中寻找EMA50反弹做空机会
        // 条件：收盘价在EMA50下方指定范围内且没有长下影线
        if (this.lastFiveMinuteClosePrice >= indicators.ema50 - ema50Range &&
          this.lastFiveMinuteClosePrice <= indicators.ema50 &&
          !this.isLowerShadowTooLarge(lastFiveKline)) {
          score -= 80;
          reasoning.push(`趋势策略: 空头反弹EMA50做空｜收盘${this.lastFiveMinuteClosePrice.toFixed(0)} ≈ EMA50 ${indicators.ema50.toFixed(0)}`);
        }
        // 注意：EMA150反弹在实盘表现为多头突破（胜率仅33%），已下线
      }
    }

    // 趋势策略：EMA50/EMA200平行趋势 - 仅保留上升趋势平行回踩（下降平行回踩在实盘3笔全损，已停用）
    if (!this.isFiveMinuteUsed) {
      const emaTrendStrategy = this.detectEma200TrendPullbackStrategy(fiveMinuteKlines);
      if (emaTrendStrategy && emaTrendStrategy.direction === 'UP') {
        score += 80;
        reasoning.push(emaTrendStrategy.reasoning);
      }
    }

    // 5连跌超跌反弹策略（实盘表现优异）
    if (!this.isFiveMinuteUsed && fiveMinuteKlines.length >= 5) {
      const recentFiveCandles = fiveMinuteKlines.slice(-5); // 最近5根K线

      // 计算最近5根K线中的最高价和最低价
      const highestHigh = Math.max(...recentFiveCandles.map(k => k.high));
      const lowestLow = Math.min(...recentFiveCandles.map(k => k.low));
      const priceRange = highestHigh - lowestLow;

      console.log(`最近5根K线: 最高价=${highestHigh.toFixed(2)}, 最低价=${lowestLow.toFixed(2)}, 价差=${priceRange.toFixed(2)}`);

      const is5ConsecutiveDown = this.checkConsecutiveTrend(recentFiveCandles, 'DOWN');

      // 5连跌且价差达到有效阈值（至少120点，防止窄幅震荡误触）时进场做多
      if (is5ConsecutiveDown && priceRange >= 120) {
        score += 80;
        reasoning.push(`反转策略: 5连跌超跌反弹做多｜价差${priceRange.toFixed(0)}点`);
      }
      // 5连涨做空已下线：BTC上涨常伴随空头挤压（Short Squeeze），逆势摸顶亏损严重
    }

    // 长下影阳线吞没前一根阴线
    if (!this.isFiveMinuteUsed && fiveMinuteKlines.length >= 2) {
      const currentKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];
      const previousKline = fiveMinuteKlines[fiveMinuteKlines.length - 2];

      // 判断当前K线是否为阳线
      const isCurrentBullish = currentKline.close > currentKline.open;
      // 判断前一根K线是否为阴线
      const isPreviousBearish = previousKline.close < previousKline.open;

      // 计算当前K线的下影线长度
      const currentLowerShadow = currentKline.open - currentKline.low;

      // 计算当前K线的实体长度
      const currentBodyLength = Math.abs(currentKline.close - currentKline.open);

      // 判断是否为长下影线（下影线长度大于实体长度）
      const isLongLowerShadow = currentLowerShadow > currentBodyLength;

      // 前一根必须是阴线，且当前K线的收盘价高于前一根阴线的最高价，开盘价低于前一根阴线的收盘价
      const isEngulfing = isPreviousBearish && currentKline.close >= previousKline.high;

      if (isCurrentBullish && isPreviousBearish && isLongLowerShadow && isEngulfing) {
        score += 80;
        reasoning.push(`反转策略: 长下影阳线吞没做多`);
      }
    }

    // 长上影阴线吞没前一根阳线
    if (!this.isFiveMinuteUsed && fiveMinuteKlines.length >= 2) {
      const currentKline = fiveMinuteKlines[fiveMinuteKlines.length - 1];
      const previousKline = fiveMinuteKlines[fiveMinuteKlines.length - 2];

      // 判断当前K线是否为阴线
      const isCurrentBearish = currentKline.close < currentKline.open;
      // 判断前一根K线是否为阳线
      const isPreviousBullish = previousKline.close > previousKline.open;

      // 计算当前K线的上影线长度
      const currentUpperShadow = currentKline.high - currentKline.open;

      // 计算当前K线的实体长度
      const currentBodyLength = Math.abs(currentKline.close - currentKline.open);

      // 判断是否为长上影线（上影线长度大于实体长度的1倍）
      const isLongUpperShadow = currentUpperShadow > currentBodyLength;

      // 前一根必须是阳线，且当前K线的收盘价低于前一根K线的开盘价，开盘价高于前一根K线的收盘价
      const isEngulfing = isPreviousBullish && currentKline.close <= previousKline.low;

      if (isCurrentBearish && isPreviousBullish && isLongUpperShadow && isEngulfing) {
        score -= 80;
        reasoning.push(`反转策略: 长上影阴线吞没做空`);
      }
    }


    // 偏离均线策略
    if (!this.isFiveMinuteUsed) {
      // 计算当前5分钟K线收盘价偏离EMA50的涨幅
      const deviation = this.lastFiveMinuteClosePrice - indicators.ema50;
      const deviationPercent = (deviation / indicators.ema50) * 100;

      console.log(`偏离EMA50: ${deviationPercent.toFixed(2)}% (${deviation.toFixed(0)}点)`);

      // 5分钟K线收盘价偏离EMA50超过1.2%
      if (deviationPercent > 1.2) {
        score -= 80;
        reasoning.push(`反转策略: 偏离EMA50做空｜${this.lastFiveMinuteClosePrice.toFixed(0)} vs ${indicators.ema50.toFixed(0)} (+${deviationPercent.toFixed(1)}%)`);
      }

      if (deviationPercent < -1.2) {
        score += 80;
        reasoning.push(`反转策略: 偏离EMA50做多｜${this.lastFiveMinuteClosePrice.toFixed(0)} vs ${indicators.ema50.toFixed(0)} (${deviationPercent.toFixed(1)}%)`);
      }
    }

    // 确定趋势方向
    const direction = score > 0 ? 'UP' : 'DOWN';
    const confidence = Math.min(Math.abs(score), 100);

    return {
      direction,
      confidence,
      reasoning,
      indicators
    };
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
   * 5连涨：必须是阳线（收盘价 > 开盘价）且收盘价连续上涨
   * 5连跌：必须是阴线（收盘价 < 开盘价）且收盘价连续下跌
   */
  private checkConsecutiveTrend(candles: IPriceData[], direction: 'UP' | 'DOWN'): boolean {
    if (candles.length < 5) return false;

    for (let i = 0; i < candles.length; i++) {
      const currentCandle = candles[i];
      const currentClose = +currentCandle.close;
      const currentOpen = +currentCandle.open;

      if (direction === 'UP') {
        // 5连涨：必须是阳线（收盘价 > 开盘价）
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
        // 5连跌：必须是阴线（收盘价 < 开盘价）
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