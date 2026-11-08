import { IPriceData } from '../models/PriceData';

export interface PredictionResult {
  direction: 'UP' | 'DOWN';
  confidence: number;
  reasoning: string[];
}

/**
 * 技术指标已移除。不再计算 EMA、RSI、MACD、布林带，也不再据此给出方向。
 */
export class TechnicalAnalysisService {
  async predictDirection(
    _priceHistory: IPriceData[],
    _fiveMinuteKlines: any[]
  ): Promise<PredictionResult> {
    return {
      direction: 'UP',
      confidence: 0,
      reasoning: []
    };
  }
}
