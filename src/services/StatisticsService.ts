import TradeModel, { ITrade } from '../models/Trade';

export interface WinRateStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  openTrades: number;
  totalInvestment: number; // 总交易额
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  totalProfitLoss: number;
  bestTrade: number;
  worstTrade: number;
  averageConfidence: number;
  winRateByConfidence: {
    high: number; // >= 85%
    medium: number; // 70-84%
    low: number; // < 70%
  };
}

export interface PerformanceMetrics {
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  profitConsistency: number;
}

export class StatisticsService {
  /**
   * 计算胜率统计
   */
  async calculateWinRate(timeRange?: { start: Date; end: Date }): Promise<WinRateStats> {
    let query: any = {}; // 包含所有交易，包括持仓中的

    if (timeRange) {
      query.timestamp = {
        $gte: timeRange.start,
        $lte: timeRange.end
      };
    }

    const trades = await TradeModel.find(query).lean();

    if (trades.length === 0) {
      return this.getDefaultStats();
    }

    // 区分已平仓和持仓中的交易
    const closedTrades = trades.filter(t => t.isCorrect !== undefined);
    const openTrades = trades.filter(t => t.isCorrect === undefined);

    const winningTrades = closedTrades.filter(t => t.isCorrect);
    const losingTrades = closedTrades.filter(t => !t.isCorrect);

    // 总交易数包括所有开仓的交易
    const totalTrades = trades.length;
    // 胜率只基于已平仓的交易计算
    const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0;

    const winningProfits = winningTrades.map(t => t.profitLoss || 0);
    const losingLosses = losingTrades.map(t => Math.abs(t.profitLoss || 0));

    const averageWin = winningProfits.length > 0 ?
      winningProfits.reduce((a, b) => a + b, 0) / winningProfits.length : 0;

    const averageLoss = losingLosses.length > 0 ?
      losingLosses.reduce((a, b) => a + b, 0) / losingLosses.length : 0;

    const totalProfit = winningProfits.reduce((a, b) => a + b, 0);
    const totalLoss = losingLosses.reduce((a, b) => a + b, 0);

    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const allProfits = closedTrades.map(t => t.profitLoss || 0);
    const bestTrade = allProfits.length > 0 ? Math.max(...allProfits) : 0;
    const worstTrade = allProfits.length > 0 ? Math.min(...allProfits) : 0;

    const averageConfidence = closedTrades.length > 0 ?
      closedTrades.reduce((sum, t) => sum + t.confidence, 0) / closedTrades.length : 0;

    const winRateByConfidence = this.calculateWinRateByConfidence(closedTrades);

    return {
      totalTrades: totalTrades,        // 总交易数（包括持仓中）
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      openTrades: openTrades.length,   // 持仓中的交易数
      totalInvestment: trades.reduce((sum, trade) => sum + (trade.investmentAmount || 0), 0), // 总交易额
      winRate,
      averageWin,
      averageLoss,
      profitFactor,
      totalProfitLoss: totalProfit - totalLoss,
      bestTrade,
      worstTrade,
      averageConfidence,
      winRateByConfidence
    };
  }

  /**
   * 计算性能指标
   */
  async calculatePerformanceMetrics(timeRange?: { start: Date; end: Date }): Promise<PerformanceMetrics> {
    let query: any = { isCorrect: { $exists: true } };

    if (timeRange) {
      query.timestamp = {
        $gte: timeRange.start,
        $lte: timeRange.end
      };
    }

    const trades = await TradeModel.find(query).sort({ timestamp: 1 }).lean();

    if (trades.length === 0) {
      return {
        sharpeRatio: 0,
        maxDrawdown: 0,
        recoveryFactor: 0,
        profitConsistency: 0
      };
    }

    // 计算夏普比率
    const returns = trades.map(t => (t.profitLoss || 0));
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(144) : 0; // 假设每天144个10分钟周期

    // 计算最大回撤
    const equity = this.calculateEquity(returns);
    const maxDrawdown = this.calculateMaxDrawdown(equity);

    // 计算恢复因子
    const totalProfit = Math.max(equity[equity.length - 1] - equity[0], 0);
    const recoveryFactor = maxDrawdown > 0 ? totalProfit / maxDrawdown : totalProfit > 0 ? Infinity : 0;

    // 计算盈利一致性
    const profitConsistency = this.calculateProfitConsistency(returns);

    return {
      sharpeRatio,
      maxDrawdown,
      recoveryFactor,
      profitConsistency
    };
  }

  /**
   * 获取最近交易记录
   */
  async getRecentTrades(limit: number = 20): Promise<ITrade[]> {
    return await TradeModel
      .find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * 按置信度分组计算胜率
   */
  private calculateWinRateByConfidence(trades: ITrade[]): { high: number; medium: number; low: number } {
    const highConfidence = trades.filter(t => t.confidence >= 85);
    const mediumConfidence = trades.filter(t => t.confidence >= 70 && t.confidence < 85);
    const lowConfidence = trades.filter(t => t.confidence < 70);

    return {
      high: highConfidence.length > 0 ? (highConfidence.filter(t => t.isCorrect).length / highConfidence.length) * 100 : 0,
      medium: mediumConfidence.length > 0 ? (mediumConfidence.filter(t => t.isCorrect).length / mediumConfidence.length) * 100 : 0,
      low: lowConfidence.length > 0 ? (lowConfidence.filter(t => t.isCorrect).length / lowConfidence.length) * 100 : 0
    };
  }

  /**
   * 计算权益曲线
   */
  private calculateEquity(returns: number[]): number[] {
    const equity: number[] = [10000]; // 初始资金10000

    for (const ret of returns) {
      equity.push(equity[equity.length - 1] + ret);
    }

    return equity;
  }

  /**
   * 计算最大回撤
   */
  private calculateMaxDrawdown(equity: number[]): number {
    let maxDrawdown = 0;
    let peak = equity[0];

    for (const value of equity) {
      if (value > peak) {
        peak = value;
      }

      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // 转换为百分比
  }

  /**
   * 计算盈利一致性
   */
  private calculateProfitConsistency(returns: number[]): number {
    if (returns.length < 2) return 0;

    const positivePeriods = returns.filter(r => r > 0).length;
    const totalPeriods = returns.length;

    // 计算连续盈利期
    let consecutiveWins = 0;
    let maxConsecutiveWins = 0;

    for (const ret of returns) {
      if (ret > 0) {
        consecutiveWins++;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, consecutiveWins);
      } else {
        consecutiveWins = 0;
      }
    }

    const winRate = positivePeriods / totalPeriods;
    const consistencyBonus = (maxConsecutiveWins / totalPeriods) * 20;

    return Math.min(winRate * 100 + consistencyBonus, 100);
  }

  /**
   * 获取默认统计数据
   */
  private getDefaultStats(): WinRateStats {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      openTrades: 0,
      totalInvestment: 0,
      winRate: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      totalProfitLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      averageConfidence: 0,
      winRateByConfidence: {
        high: 0,
        medium: 0,
        low: 0
      }
    };
  }
}