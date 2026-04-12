import { TechnicalAnalysisService } from '../services/TechnicalAnalysis';
import { IPriceData } from '../models/PriceData';
import { BinanceService } from '../services/BinanceService';

interface BacktestResult {
    totalTrades: number;
    correctPredictions: number;
    accuracy: number;
    profit: number;
    winRate: number;
    averageProfit: number;
    trades: BacktestTrade[];
}

interface BacktestTrade {
    timestamp: Date;
    predictedDirection: 'UP' | 'DOWN';
    actualDirection: 'UP' | 'DOWN';
    entryPrice: number;
    exitPrice: number;
    profit: number;
    correct: boolean;
    confidence: number;
    reasoning: string[];
}

/**
 * 从币安 API 获取历史 K 线数据
 * @param interval 时间间隔，如 1m (1分钟), 5m (5分钟)
 * @param limit 数据点数量
 * @returns 历史 K 线数据
 */
async function fetchBinanceHistoricalData(interval: string, limit: number): Promise<any[]> {
    try {
        const binanceService = new BinanceService();
        const klines = await binanceService.getKlines(interval, limit);

        // 转换币安 API 响应格式为我们需要的格式
        return klines.map((kline: any) => {
            return {
                openTime: kline.openTime,
                open: parseFloat(kline.open),
                high: parseFloat(kline.high),
                low: parseFloat(kline.low),
                close: parseFloat(kline.close),
                volume: parseFloat(kline.volume),
                closeTime: kline.closeTime
            };
        });
    } catch (error) {
        console.error('获取币安历史数据失败:', error);
        throw error;
    }
}

/**
 * 将 K 线数据转换为 IPriceData 格式
 * @param klines K 线数据
 * @returns IPriceData 格式的数据
 */
function convertKlinesToPriceData(klines: any[]): IPriceData[] {
    return klines.map((kline, index) => {
        const timestamp = new Date(kline.openTime);
        return {
            _id: `binance-${index}`,
            symbol: 'BTCUSDT',
            timestamp,
            price: kline.close,
            volume: kline.volume,
            high: kline.high,
            low: kline.low,
            open: kline.open,
            close: kline.close
        } as IPriceData;
    });
}

/**
 * 执行回测
 * @param priceHistory 价格历史数据
 * @param fiveMinuteKlines 5分钟K线数据
 * @returns 回测结果
 */
async function runBacktest(priceHistory: IPriceData[], fiveMinuteKlines: any[]): Promise<BacktestResult> {
    const taService = new TechnicalAnalysisService();
    const trades: BacktestTrade[] = [];

    // 确保有足够的数据进行回测
    if (fiveMinuteKlines.length < 2) {
        throw new Error('需要至少2根5分钟K线数据进行回测');
    }

    for (let i = 150; i < fiveMinuteKlines.length - 1; i++) {
        try {
            // 准备当前K线和之前的价格数据
            const currentKlines = fiveMinuteKlines.slice(0, i + 1);
            const currentPriceHistory = priceHistory.slice(0, (i + 1) * 5);

            // 预测方向
            const prediction = await taService.predictDirection(currentPriceHistory, currentKlines);

            // 获取下一根K线的实际方向
            const nextKline = fiveMinuteKlines[i + 1];
            const actualDirection = nextKline.close > currentKlines[i].close ? 'UP' : 'DOWN';

            // 计算交易结果
            const entryPrice = currentKlines[i].close;
            const exitPrice = nextKline.close;
            const profit = prediction.direction === 'UP' ? exitPrice - entryPrice : entryPrice - exitPrice;
            const correct = prediction.direction === actualDirection;

            // 记录交易
            trades.push({
                timestamp: new Date(currentKlines[i].closeTime),
                predictedDirection: prediction.direction,
                actualDirection,
                entryPrice,
                exitPrice,
                profit,
                correct,
                confidence: prediction.confidence,
                reasoning: prediction.reasoning
            });

        } catch (error) {
            console.error(`回测过程中出错: ${error}`);
        }
    }

    // 计算回测指标
    const totalTrades = trades.length;
    const correctPredictions = trades.filter(t => t.correct).length;
    const accuracy = totalTrades > 0 ? (correctPredictions / totalTrades) * 100 : 0;
    const profit = trades.reduce((sum, t) => sum + t.profit, 0);
    const winRate = totalTrades > 0 ? (trades.filter(t => t.profit > 0).length / totalTrades) * 100 : 0;
    const averageProfit = totalTrades > 0 ? profit / totalTrades : 0;

    return {
        totalTrades,
        correctPredictions,
        accuracy,
        profit,
        winRate,
        averageProfit,
        trades
    };
}

/**
 * 主函数
 */
async function main() {
    console.log('开始回测...');

    // 从币安 API 获取真实历史数据
    const interval = '5m'; // 5分钟K线
    const limit = 1000; // 获取500根K线，约41小时的数据

    console.log(`从币安 API 获取数据: 时间间隔=${interval}, 数据点=${limit}`);

    // 获取5分钟K线数据
    const fiveMinuteKlines = await fetchBinanceHistoricalData(interval, limit);

    // 获取1分钟K线数据用于生成价格历史
    const oneMinuteKlines = await fetchBinanceHistoricalData('1m', limit * 5);
    const priceHistory = convertKlinesToPriceData(oneMinuteKlines);

    console.log(`获取的价格历史数据: ${priceHistory.length} 个数据点`);
    console.log(`获取的5分钟K线数据: ${fiveMinuteKlines.length} 根K线`);
    console.log(`数据时间范围: ${new Date(fiveMinuteKlines[0].openTime).toLocaleString()} 到 ${new Date(fiveMinuteKlines[fiveMinuteKlines.length - 1].closeTime).toLocaleString()}`);

    // 执行回测
    const result = await runBacktest(priceHistory, fiveMinuteKlines);

    // 输出回测结果
    console.log('\n回测结果:');
    console.log(`总交易次数: ${result.totalTrades}`);
    console.log(`正确预测次数: ${result.correctPredictions}`);
    console.log(`准确率: ${result.accuracy.toFixed(2)}%`);
    console.log(`总盈利: ${result.profit.toFixed(2)}`);
    console.log(`胜率: ${result.winRate.toFixed(2)}%`);
    console.log(`平均盈利: ${result.averageProfit.toFixed(2)}`);

    // 输出前10笔交易详情
    console.log('\n前10笔交易详情:');
    result.trades.slice(0, 10).forEach((trade, index) => {
        console.log(`\n交易 ${index + 1}:`);
        console.log(`时间: ${trade.timestamp.toLocaleString()}`);
        console.log(`预测方向: ${trade.predictedDirection}`);
        console.log(`实际方向: ${trade.actualDirection}`);
        console.log(`入场价格: ${trade.entryPrice.toFixed(2)}`);
        console.log(`出场价格: ${trade.exitPrice.toFixed(2)}`);
        console.log(`盈利: ${trade.profit.toFixed(2)}`);
        console.log(`是否正确: ${trade.correct}`);
        console.log(`置信度: ${trade.confidence}%`);
        console.log(`理由: ${trade.reasoning.join(', ')}`);
    });
}

// 运行回测
main().catch(console.error);