import mongoose, { Schema, Document } from 'mongoose';

export interface ITrade extends Document {
  symbol: string;
  timestamp: Date;           // 开仓时间
  price: number;             // 开仓价格
  signal: 'BUY' | 'SELL';   // 交易信号：BUY=做多，SELL=做空
  confidence: number;
  tradeType: 'LONG' | 'SHORT'; // 交易类型：做多或做空
  investmentAmount: number;  // 买入金额（固定本金）
  reasoning?: string[];       // 入场原因
  prediction: 'UP' | 'DOWN';
  orderSource?: 'MANUAL' | 'AUTO'; // 订单来源：MANUAL=手动开单，AUTO=系统自动策略单

  // 信号所基于的5分钟K线收盘时间戳（毫秒），和 strategyId 一起去重
  klineCloseTime?: number;
  strategyId?: string;
  strategyName?: string;

  // 平仓相关字段
  closeTime?: Date;          // 平仓时间
  closePrice?: number;       // 平仓价格
  holdDuration?: number;     // 持仓时间（分钟）

  // 结果评估
  actualDirection?: 'UP' | 'DOWN';
  isCorrect?: boolean;       // 预测是否正确
  profitLoss?: number;       // 盈亏金额（正数为盈利，负数为亏损）
  profitLossPercent?: number; // 盈亏百分比
}

const TradeSchema: Schema = new Schema({
  symbol: { type: String, required: true, default: 'BTCUSDT' },
  timestamp: { type: Date, required: true, default: Date.now },
  price: { type: Number, required: true },
  signal: { type: String, required: true, enum: ['BUY', 'SELL'] },
  tradeType: { type: String, required: true, enum: ['LONG', 'SHORT'] },
  confidence: { type: Number, required: true, min: 0, max: 100 },
  investmentAmount: { type: Number, required: true, default: 100 }, // 默认买入金额100U
  reasoning: [{ type: String }], // 入场原因
  prediction: { type: String, required: true, enum: ['UP', 'DOWN'] },
  orderSource: { type: String, enum: ['MANUAL', 'AUTO'], default: 'AUTO' },

  // 信号所基于的5分钟K线收盘时间戳，和 strategyId 一起去重
  klineCloseTime: { type: Number },
  strategyId: { type: String },
  strategyName: { type: String },

  // 平仓相关字段
  closeTime: { type: Date },
  closePrice: { type: Number },
  holdDuration: { type: Number }, // 持仓时间（分钟）

  // 结果评估
  actualDirection: { type: String, enum: ['UP', 'DOWN'] },
  isCorrect: { type: Boolean },
  profitLoss: { type: Number },
  profitLossPercent: { type: Number }
}, {
  timestamps: true
});
// 创建索引以提高查询性能
TradeSchema.index({ timestamp: -1 });
TradeSchema.index({ signal: 1 });
TradeSchema.index({ isCorrect: 1 });
TradeSchema.index({ orderSource: 1 });
// 同一品种、同一策略、同一根5分钟K线只允许一笔。
// 部分索引只约束带 strategyId 的新单，历史单和手动单不受影响。
// 旧的 {symbol, klineCloseTime} 唯一索引会让同一根K线只能留一条策略，启动时由 ensureTradeIndexes 删掉。
TradeSchema.index(
  { symbol: 1, strategyId: 1, klineCloseTime: 1 },
  {
    unique: true,
    partialFilterExpression: {
      strategyId: { $type: 'string' },
      klineCloseTime: { $type: 'number' }
    }
  }
);

export function isLegacyKlineUniqueIndex(index: { unique?: boolean; key?: Record<string, unknown> }): boolean {
  if (index.unique !== true || !index.key) return false;
  const key = index.key;
  const fields = Object.keys(key);
  return fields.length === 2 && key.symbol === 1 && key.klineCloseTime === 1 && !('strategyId' in key);
}

/** 删掉旧的「一根K线只能有一笔」唯一索引，再确保按策略分开的唯一索引存在。 */
export async function ensureTradeIndexes(): Promise<void> {
  const collection = mongoose.model<ITrade>('Trade').collection;
  const indexes = await collection.indexes();
  for (const index of indexes) {
    if (!isLegacyKlineUniqueIndex(index) || !index.name) continue;
    await collection.dropIndex(index.name);
    console.log(`已删除旧唯一索引 ${index.name}。同一根K线可以按策略分别记录`);
  }
  await mongoose.model<ITrade>('Trade').createIndexes();
}

export default mongoose.model<ITrade>('Trade', TradeSchema);