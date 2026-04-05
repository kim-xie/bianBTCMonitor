import * as ti from 'technicalindicators';
import { IPriceData } from '../models/PriceData';
import { BinanceService } from './BinanceService';

export interface IndicatorResult {
  ema50: number;
  ema150: number;
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

  /**
 * 将1分钟K线转换为5分钟K线
 */
  private convertToOneFiveMinuteCandles(priceHistory: IPriceData[]): IPriceData[] {
    const fiveMinuteCandles: any[] = [];

    // 确保数据按时间戳排序
    const sortedHistory = [...priceHistory].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // 找到第一个时间戳能够被5分钟整除的K线
    let startIndex = 0;
    while (startIndex < sortedHistory.length) {
      const timestamp = sortedHistory[startIndex].timestamp;
      const minutes = timestamp.getMinutes();
      if (minutes % 5 === 0) {
        break;
      }
      startIndex++;
    }

    // 从对齐的时间开始，每5根1分钟K线一组
    for (let i = startIndex; i < sortedHistory.length; i += 5) {
      // 确保有足够的K线组成一组
      if (i + 5 <= sortedHistory.length) {
        const group = sortedHistory.slice(i, i + 5);

        const fiveMinuteCandle = {
          symbol: group[0].symbol,
          timestamp: group[0].timestamp, // 使用第一根K线的时间
          price: group[4].close, // 收盘价作为价格
          volume: group.reduce((sum, k) => sum + k.volume, 0), // 成交量之和
          high: Math.max(...group.map(k => k.high)), // 最高价格
          low: Math.min(...group.map(k => k.low)), // 最低价格
          open: group[0].open, // 第一根K线的开盘价
          close: group[4].close // 最后一根K线的收盘价
        };

        fiveMinuteCandles.push(fiveMinuteCandle);
      }
    }

    return fiveMinuteCandles;
  }

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

    const ema50 = ema50Values[ema50Values.length - 1] || fiveMinutePrices[fiveMinutePrices.length - 1];
    const ema150 = ema150Values[ema150Values.length - 1] || fiveMinutePrices[fiveMinutePrices.length - 1];

    // 判断趋势
    const trend = this.determineTrend(ema50, ema150);

    // 计算波动率
    const volatility = this.calculateVolatility(prices);

    return {
      ema50,
      ema150,
      trend,
      volatility
    };
  }

  /**
   * 预测未来10分钟价格走势
   */
  async predictDirection(priceHistory: IPriceData[], fiveMinuteKlines: any[]): Promise<PredictionResult> {
    const indicators = await this.calculateIndicators(priceHistory, fiveMinuteKlines);
    const currentPrice = priceHistory[priceHistory.length - 1].close;

    let score = 0;
    const reasoning: string[] = [];

    // 判断5分钟K线主要趋势方向
    const isBullishTrend = indicators.ema50 > indicators.ema150;
    const isBearishTrend = indicators.ema50 < indicators.ema150;

    // 寻找回调入场机会（逆势交易）
    const ema50Range = 20; // EMA50上下20个点的范围

    console.log('isBullishTrend:', isBullishTrend, 'isBearishTrend:', isBearishTrend);
    console.log('currentPrice:', currentPrice, 'indicators.ema50:', indicators.ema50, 'indicators.ema150:', indicators.ema150);

    if (isBullishTrend) {
      // 上涨趋势中寻找回调做多机会
      if (Math.abs(currentPrice - indicators.ema50) <= ema50Range) {
        // 5分钟K线收盘价在EMA50价格上下20个点范围内，适合做多
        score += 80;
        reasoning.push(`上涨趋势中价格回调至EMA50(${indicators.ema50.toFixed(2)})上下20个点范围内，进场做多`);
      }
    } else if (isBearishTrend) {
      // 下跌趋势中寻找反弹做空机会
      if (Math.abs(currentPrice - indicators.ema50) <= ema50Range) {
        // 5分钟K线收盘价在EMA50价格上下30个点范围内，适合做空
        score -= 80;
        reasoning.push(`下跌趋势中价格回调至EMA50(${indicators.ema50.toFixed(2)})上下20个点范围内，进场做空`);
      }
    }

    // 5连涨/5连跌入场信号
    // 确保有足够的5分钟K线数据
    if (fiveMinuteKlines.length < 5) {
      throw new Error('需要至少5个5分钟K线数据点进行技术分析');
    }
    let hasConsecutiveSignal = false;
    if (fiveMinuteKlines.length >= 6) {
      const recentCandles = fiveMinuteKlines.slice(-6); // 最近6根K线
      const is5ConsecutiveUp = this.checkConsecutiveTrend(recentCandles.slice(0, 5), 'UP');
      const is5ConsecutiveDown = this.checkConsecutiveTrend(recentCandles.slice(0, 5), 'DOWN');

      const sixthCandle = recentCandles[5]; // 第6根K线

      if (is5ConsecutiveUp) {
        // 5连涨，第六根K线开盘即做空
        score -= 80;
        reasoning.push(`5分钟K线5连涨，第六根K线开盘价(${sixthCandle.open.toFixed(2)})进场做空`);
        hasConsecutiveSignal = true;
      } else if (is5ConsecutiveDown) {
        // 5连跌，第六根K线开盘即做多
        score += 80;
        reasoning.push(`5分钟K线5连跌，第六根K线开盘价(${sixthCandle.open.toFixed(2)})进场做多`);
        hasConsecutiveSignal = true;
      }
    }

    // 确认是否有有效的回调（5连涨/5连跌信号不需要回调确认）
    if (!hasConsecutiveSignal) {
      const hasRetracement = this.hasValidRetracement(priceHistory, indicators.ema50, indicators.ema150);
      if (!hasRetracement && (score !== 0)) {
        score *= 0.3; // 降低没有有效回调的信号的权重
        reasoning.push('需要确认有效的价格回调');
      }
    }

    // 波动率过滤
    if (indicators.volatility < 0.005) {
      score *= 0.5; // 极低波动率时减少信号权重
      reasoning.push(`波动率过低(${indicators.volatility.toFixed(4)})，等待更好的入场机会`);
    }

    const direction = score > 0 ? 'UP' : 'DOWN';
    const confidence = Math.min(Math.abs(score), 100);

    return {
      direction,
      confidence,
      reasoning,
      indicators
    };
  }

  /**
   * 检查是否有有效的价格回调
   */
  private hasValidRetracement(priceHistory: IPriceData[], ema50: number, ema150: number): boolean {
    if (priceHistory.length < 10) return false;

    const recentPrices = priceHistory.slice(-10).map(p => p.close);
    const currentPrice = recentPrices[recentPrices.length - 1];

    // 计算最近的价格波动幅度
    const maxPrice = Math.max(...recentPrices);
    const minPrice = Math.min(...recentPrices);
    const priceRange = maxPrice - minPrice;

    // 如果价格波动足够大（至少2%），认为回调有效
    if (priceRange / maxPrice < 0.02) return false;

    // 检查是否确实从相反方向回调到均线附近
    const prevPrice = recentPrices[recentPrices.length - 2];

    if (currentPrice > prevPrice) {
      // 当前在上涨，检查是否从下方回调
      return currentPrice >= ema50 && currentPrice <= ema150;
    } else {
      // 当前在下跌，检查是否从上方回调
      return currentPrice <= ema50 && currentPrice >= ema150;
    }
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
   */
  private checkConsecutiveTrend(candles: IPriceData[], direction: 'UP' | 'DOWN'): boolean {
    if (candles.length < 5) return false;

    for (let i = 1; i < candles.length; i++) {
      const currentCandle = candles[i];
      const previousCandle = candles[i - 1];

      if (direction === 'UP') {
        // 检查是否连续上涨（收盘价高于前一根）
        if (currentCandle.close <= previousCandle.close) {
          return false;
        }
      } else {
        // 检查是否连续下跌（收盘价低于前一根）
        if (currentCandle.close >= previousCandle.close) {
          return false;
        }
      }
    }

    return true;
  }
}