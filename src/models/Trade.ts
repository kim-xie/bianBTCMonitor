import mongoose, { Schema, Document } from 'mongoose';

export interface ITrade extends Document {
  symbol: string;
  timestamp: Date;           // 开仓时间
  price: number;             // 开仓价格
  signal: 'BUY' | 'SELL';   // 交易信号：BUY=做多，SELL=做空
  confidence: number;
  tradeType: 'LONG' | 'SHORT'; // 交易类型：做多或做空
  investmentAmount: number;  // 买入金额（固定本金）
  indicators: any;
  reasoning?: string[];       // 入场原因
  prediction: 'UP' | 'DOWN';

  // 信号所基于的5分钟K线收盘时间戳（毫秒），用于同根K线去重
  klineCloseTime?: number;

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
  investmentAmount: { type: Number, required: true, default: 5 }, // 默认买入金额5U
  indicators: {
    ema50: { type: Number, required: true },
    ema150: { type: Number, required: true },
  },
  reasoning: [{ type: String }], // 入场原因
  prediction: { type: String, required: true, enum: ['UP', 'DOWN'] },

  // 信号所基于的5分钟K线收盘时间戳，用于同根K线去重
  klineCloseTime: { type: Number },

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
// 同一品种同一根5分钟K线只允许一笔交易（稀疏索引：历史无该字段的旧数据不参与约束）
TradeSchema.index({ symbol: 1, klineCloseTime: 1 }, { unique: true, sparse: true });

export default mongoose.model<ITrade>('Trade', TradeSchema);