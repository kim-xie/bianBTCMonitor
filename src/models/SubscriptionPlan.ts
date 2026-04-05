import mongoose, { Document, Schema } from 'mongoose';

export interface ISubscriptionPlan extends Document {
  name: string;
  description: string;
  price: number; // 美元价格
  duration: 'weekly' | 'monthly' | 'quarterly'; // 订阅时长
  features: string[]; // 套餐特性
  isActive: boolean;
  createdAt: Date;
}

const SubscriptionPlanSchema: Schema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  duration: {
    type: String,
    required: true,
    enum: ['weekly', 'monthly', 'quarterly']
  },
  features: [{
    type: String,
    required: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// 创建默认套餐数据
export const createDefaultPlans = async (PlanModel: mongoose.Model<ISubscriptionPlan>) => {
  const defaultPlans = [
    {
      name: '免费试用',
      description: '新用户免费试用1天的BTC交易监控服务',
      price: 0,
      duration: 'weekly' as const,
      features: [
        '实时BTC价格监控',
        '基础交易信号',
        '历史数据分析',
        '邮件通知'
      ]
    },
    {
      name: '周套餐',
      description: '每周30美元的BTC交易监控服务',
      price: 30,
      duration: 'weekly' as const,
      features: [
        '实时BTC价格监控',
        '基础交易信号',
        '历史数据分析',
        '邮件通知'
      ]
    },
    {
      name: '月套餐',
      description: '每月100美元的BTC交易监控服务',
      price: 100,
      duration: 'monthly' as const,
      features: [
        '实时BTC价格监控',
        '高级交易信号分析',
        '完整历史数据分析',
        '短信和邮件通知',
        'API访问权限',
        '自定义警报设置'
      ]
    },
    {
      name: '季度套餐',
      description: '每季度280美元的BTC交易监控服务（最优惠）',
      price: 280,
      duration: 'quarterly' as const,
      features: [
        '实时BTC价格监控',
        'AI驱动的高级交易信号',
        '深度历史数据分析和预测',
        '多渠道通知（短信、邮件、APP推送）',
        '完整API访问权限',
        '自定义警报和策略',
        '专属客服支持',
        '优先功能更新'
      ]
    }
  ];

  try {
    const count = await PlanModel.countDocuments();
    if (count === 0) {
      await PlanModel.insertMany(defaultPlans);
      console.log('默认订阅套餐已创建');
    }
  } catch (error) {
    console.error('创建默认套餐失败:', error);
  }
};

const SubscriptionPlanModel = mongoose.model<ISubscriptionPlan>('SubscriptionPlan', SubscriptionPlanSchema);

export default SubscriptionPlanModel;