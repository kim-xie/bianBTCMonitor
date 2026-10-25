require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const col = mongoose.connection.db.collection('trades');

    // 1. 找出同根K线的重复组
    const groups = await col.aggregate([
        { $match: { klineCloseTime: { $exists: true } } },
        { $sort: { timestamp: 1 } },
        {
            $group: {
                _id: { symbol: '$symbol', klineCloseTime: '$klineCloseTime' },
                keepId: { $first: '$_id' },
                all: { $push: '$_id' },
                count: { $sum: 1 }
            }
        },
        { $match: { count: { $gt: 1 } } }
    ]).toArray();

    // 2. 每组保留最早一笔，删除其余
    let removed = 0;
    for (const g of groups) {
        const dupIds = g.all.filter(id => !id.equals(g.keepId));
        const res = await col.deleteMany({ _id: { $in: dupIds } });
        removed += res.deletedCount;
        console.log(`K线 ${new Date(g._id.klineCloseTime).toLocaleString('zh-CN')} 重复${g.count}笔，已删除${res.deletedCount}笔`);
    }
    console.log(groups.length ? `清理完成：共${groups.length}组重复，删除${removed}笔` : '无重复数据，无需清理');

    // 3. 重建唯一稀疏索引
    try {
        await col.createIndex({ symbol: 1, klineCloseTime: 1 }, { unique: true, sparse: true });
        console.log('✅ 唯一索引 symbol_1_klineCloseTime_1 创建成功');
    } catch (e) {
        console.error('❌ 索引创建失败（可能仍存在重复数据）:', e.message);
        process.exitCode = 1;
    }

    // 4. 验证
    const names = (await col.indexes()).map(i => i.name);
    console.log('当前索引列表:', names.join(', '));

    await mongoose.disconnect();
}).catch(e => { console.error('连接失败:', e.message); process.exit(1); });