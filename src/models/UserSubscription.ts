import mongoose, { Document, Schema } from 'mongoose';

export interface IUserSubscription extends Document {
  userId: string;
  planId: string;
  status: 'active' | 'inactive' | 'expired' | 'cancelled';
  startDate: Date;
  endDate: Date;
  autoRenewal: boolean;
  paymentMethod: 'stripe' | 'paypal' | 'crypto' | null;
  transactionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSubscriptionSchema: Schema = new Schema({
  userId: {
    type: String,
    required: true,
    ref: 'User'
  },
  planId: {
    type: String,
    required: true,
    ref: 'SubscriptionPlan'
  },
  status: {
    type: String,
    required: true,
    enum: ['active', 'inactive', 'expired', 'cancelled'],
    default: 'inactive'
  },
  startDate: {
    type: Date
  },
  endDate: {
    type: Date
  },
  autoRenewal: {
    type: Boolean,
    default: false
  },
  paymentMethod: {
    type: String,
    enum: ['stripe', 'paypal', 'crypto'],
    default: null
  },
  transactionId: {
    type: String,
    default: null
  }
}, {
  timestamps: true // 自动添加createdAt和updatedAt
});

// 索引优化查询性能
UserSubscriptionSchema.index({ userId: 1 });
UserSubscriptionSchema.index({ status: 1 });
UserSubscriptionSchema.index({ endDate: 1 });

const UserSubscriptionModel = mongoose.model<IUserSubscription>('UserSubscription', UserSubscriptionSchema);

export default UserSubscriptionModel;