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
    const trades = await TradeModel.find({}).lean();

    if (trades.length === 0) {
      return this.getDefaultStats();
    }

    // 区分已平仓和持仓中的交易
    const closedTrades = trades.filter(t => t.isCorrect !== undefined);
    const openTrades = trades.filter(t => t.isCorrect === undefined);

    // 如果有时间范围，过滤出在时间范围内平仓的交易
    let filteredClosedTrades = closedTrades;
    if (timeRange) {
      filteredClosedTrades = closedTrades.filter(t => {
        if (!t.closeTime) return false;
        const closeTime = new Date(t.closeTime);
        return closeTime >= timeRange.start && closeTime <= timeRange.end;
      });
    }

    // 如果有时间范围，过滤出在时间范围内开仓的交易作为总交易数
    let filteredOpenTrades = openTrades;
    let totalTrades = trades.length;
    if (timeRange) {
      filteredOpenTrades = openTrades.filter(t => {
        const openTime = new Date(t.timestamp);
        return openTime >= timeRange.start && openTime <= timeRange.end;
      });
      totalTrades = filteredClosedTrades.length + filteredOpenTrades.length;
    }

    const winningTrades = filteredClosedTrades.filter(t => t.isCorrect);
    const losingTrades = filteredClosedTrades.filter(t => !t.isCorrect);

    // 胜率只基于已平仓的交易计算
    const winRate = filteredClosedTrades.length > 0 ? (winningTrades.length / filteredClosedTrades.length) * 100 : 0;

    const winningProfits = winningTrades.map(t => t.profitLoss || 0);
    const losingLosses = losingTrades.map(t => Math.abs(t.profitLoss || 0));

    const averageWin = winningProfits.length > 0 ?
      winningProfits.reduce((a, b) => a + b, 0) / winningProfits.length : 0;

    const averageLoss = losingLosses.length > 0 ?
      losingLosses.reduce((a, b) => a + b, 0) / losingLosses.length : 0;

    const totalProfit = winningProfits.reduce((a, b) => a + b, 0);
    const totalLoss = losingLosses.reduce((a, b) => a + b, 0);

    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const allProfits = filteredClosedTrades.map(t => t.profitLoss || 0);
    const bestTrade = allProfits.length > 0 ? Math.max(...allProfits) : 0;
    const worstTrade = allProfits.length > 0 ? Math.min(...allProfits) : 0;

    const averageConfidence = filteredClosedTrades.length > 0 ?
      filteredClosedTrades.reduce((sum, t) => sum + t.confidence, 0) / filteredClosedTrades.length : 0;

    const winRateByConfidence = this.calculateWinRateByConfidence(filteredClosedTrades);

    return {
      totalTrades: totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      openTrades: filteredOpenTrades.length,
      totalInvestment: trades.reduce((sum, trade) => sum + (trade.investmentAmount || 0), 0),
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
   * 根据条件搜索交易记录，支持按入场原因模糊查询
   */
  async searchTrades(filters?: {
    reasoningKeyword?: string;     // 入场原因关键词（模糊匹配）
    signal?: 'BUY' | 'SELL';       // 交易信号
    tradeType?: 'LONG' | 'SHORT';   // 交易类型
    confidenceMin?: number;        // 最小置信度
    confidenceMax?: number;        // 最大置信度
    startDate?: Date;              // 开始日期
    endDate?: Date;                // 结束日期
    limit?: number;                // 结果数量限制
    sortBy?: 'timestamp' | 'confidence' | 'profitLoss';
    sortOrder?: 'asc' | 'desc';
  }): Promise<ITrade[]> {
    let query: any = {};

    // 按入场原因模糊查询
    if (filters?.reasoningKeyword) {
      query.$or = [
        { 'reasoning': { $elemMatch: { $regex: filters.reasoningKeyword, $options: 'i' } } },
        { 'reasoning': { $regex: filters.reasoningKeyword, $options: 'i' } }
      ];
    }

    // 按交易信号筛选
    if (filters?.signal) {
      query.signal = filters.signal;
    }

    // 按交易类型筛选
    if (filters?.tradeType) {
      query.tradeType = filters.tradeType;
    }

    // 按置信度范围筛选
    if (filters?.confidenceMin !== undefined || filters?.confidenceMax !== undefined) {
      query.confidence = {};
      if (filters.confidenceMin !== undefined) {
        query.confidence.$gte = filters.confidenceMin;
      }
      if (filters.confidenceMax !== undefined) {
        query.confidence.$lte = filters.confidenceMax;
      }
    }

    // 按时间范围筛选
    if (filters?.startDate || filters?.endDate) {
      query.timestamp = {};
      if (filters.startDate) {
        query.timestamp.$gte = filters.startDate;
      }
      if (filters.endDate) {
        query.timestamp.$lte = filters.endDate;
      }
    }

    // 构建排序选项
    const sortOptions: any = {};
    if (filters?.sortBy) {
      sortOptions[filters.sortBy] = filters.sortOrder === 'desc' ? -1 : 1;
    } else {
      sortOptions.timestamp = -1; // 默认按时间降序排列
    }

    const limit = filters?.limit || 50;

    return await TradeModel
      .find(query)
      .sort(sortOptions)
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