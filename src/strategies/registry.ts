export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
}

export interface StrategySignal {
  strategyId: string;
  direction: 'UP' | 'DOWN';
  confidence: number;
  reason: string;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  enabled: boolean;
  summary: string;
  evaluate(candles: Candle[]): StrategySignal | null;
}

/**
 * 唯一的策略定义。
 * 旧的均线反包、二次反包、连涨连跌都已下线，不在此列表中，也不会被调用。
 * enabled 为 false 时 evaluate 不会执行，因此不开仓。
 */
export const strategies: StrategyDefinition[] = [
  {
    id: 'btc-5m',
    name: 'BTC 5分钟',
    enabled: false,
    summary: [
      '品种 BTCUSDT，只看已收盘的 5 分钟 K 线。',
      '同一根 K 线最多一笔。持仓 10 分钟，每笔 100 USDT，同时最多 5 笔。',
      '10 分钟内已有同向未平仓时，不再同向开仓。',
      '图表上的 EMA50 只用于看盘，不作为入场条件。',
      '入场规则尚未写入。当前未启用，不开仓。'
    ].join(''),
    evaluate(candles: Candle[]): StrategySignal | null {
      if (candles.length < 2) return null;
      return null;
    }
  }
];

export function listStrategyDefinitions(): Array<Pick<StrategyDefinition, 'id' | 'name' | 'enabled' | 'summary'>> {
  return strategies.map(({ id, name, enabled, summary }) => ({ id, name, enabled, summary }));
}

export function evaluateStrategies(candles: Candle[]): StrategySignal | null {
  for (const strategy of strategies) {
    if (!strategy.enabled) continue;
    const signal = strategy.evaluate(candles);
    if (signal) return signal;
  }
  return null;
}
