import mongoose, { Schema, Document } from 'mongoose';

export interface IPriceData extends Document {
  symbol: string;
  timestamp: Date;
  price: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  close: number;
}

const PriceDataSchema: Schema = new Schema({
  symbol: { type: String, required: true, default: 'BTCUSDT' },
  timestamp: { type: Date, required: true, default: Date.now },
  price: { type: Number, required: true },
  volume: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  open: { type: Number, required: true },
  close: { type: Number, required: true }
}, {
  timestamps: true
});
// 创建索引
PriceDataSchema.index({ timestamp: -1 });
PriceDataSchema.index({ symbol: 1, timestamp: -1 });

export default mongoose.model<IPriceData>('PriceData', PriceDataSchema);