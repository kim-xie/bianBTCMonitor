import mongoose from 'mongoose';
import 'dotenv/config';
import TradeModel from '../src/models/Trade';
import PriceDataModel from '../src/models/PriceData';

async function resetData() {
  try {
    console.log('开始清空历史数据...');

    // 连接数据库
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/btc-trading';
    await mongoose.connect(MONGODB_URI);
    console.log('✅ 数据库连接成功');

    // 清空交易记录
    const tradesResult = await TradeModel.deleteMany({});
    console.log(`✅ 已清空交易记录: 删除了 ${tradesResult.deletedCount} 条记录`);

    // 清空价格数据
    const priceResult = await PriceDataModel.deleteMany({});
    console.log(`✅ 已清空价格数据: 删除了 ${priceResult.deletedCount} 条记录`);

    console.log('\n🎉 数据清空完成！现在可以重新开始了。');
    console.log('重置后状态：');
    console.log('- 💰 资金重置为初始值: 100U');
    console.log('- 📊 交易记录: 0');
    console.log('- 📈 统计数据: 全部清零');
    console.log('- 🔄 可以重新开始交易');

    await mongoose.disconnect();
    console.log('\n数据库连接已断开');

  } catch (error) {
    console.error('❌ 清空数据时出错:', error);
    process.exit(1);
  }
}

// 执行清空操作
resetData();