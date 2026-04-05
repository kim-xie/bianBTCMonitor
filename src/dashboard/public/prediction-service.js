// 预测成功检测和烟花触发服务
class PredictionService {
    constructor() {
        this.lastPrediction = null;
        this.isTradingActive = false;
        this.fireworkTriggered = false;
        this.init();
    }

    init() {
        // 监听交易信号更新
        this.setupSignalListener();

        // 检查历史交易结果
        this.checkRecentTrades();

        // 设置定时检查
        setInterval(() => {
            this.checkPredictionResults();
        }, 5000); // 每5秒检查一次
    }

    setupSignalListener() {
        // WebSocket连接监听交易信号
        if (typeof io !== 'undefined') {
            const socket = io();

            socket.on('tradingSignal', (signal) => {
                console.log('收到交易信号:', signal);
                this.processPrediction(signal);
            });

            socket.on('tradeResult', (result) => {
                console.log('交易结果:', result);
                this.handleTradeResult(result);
            });
        }
    }

    processPrediction(signal) {
        this.lastPrediction = {
            signal: signal.signal,
            confidence: signal.confidence,
            timestamp: new Date().toISOString()
        };

        // 显示预测信息
        this.displayPredictionInfo(signal);

        console.log('处理预测信号:', this.lastPrediction);
    }

    displayPredictionInfo(signal) {
        // 在页面上显示预测信息
        const predictionDiv = document.createElement('div');
        predictionDiv.id = 'predictionAlert';
        predictionDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            padding: 1rem;
            border-radius: 10px;
            z-index: 1000;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            animation: slideIn 0.5s ease-out;
        `;

        predictionDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <i class="fas fa-bullseye"></i>
                <strong>交易信号</strong>
            </div>
            <p style="margin: 0.5rem 0;">方向: <span style="font-weight: bold;">${signal.signal}</span></p>
            <p style="margin: 0;">置信度: <span style="font-weight: bold;">${signal.confidence}%</span></p>
            <small>时间: ${new Date().toLocaleTimeString()}</small>
        `;

        document.body.appendChild(predictionDiv);

        // 3秒后自动移除
        setTimeout(() => {
            if (predictionDiv.parentNode) {
                predictionDiv.parentNode.removeChild(predictionDiv);
            }
        }, 3000);
    }

    async checkRecentTrades() {
        try {
            const response = await fetch('/api/recent-trades', {
                headers: {
                    ...(localStorage.getItem('authToken') && {
                        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                    }),
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const trades = await response.json();
                this.analyzeTrades(trades);
            }
        } catch (error) {
            console.error('获取交易记录失败:', error);
        }
    }

    analyzeTrades(trades) {
        // 分析最近的交易结果
        const recentTrades = trades.slice(0, 5);
        const successfulTrades = recentTrades.filter(trade =>
            trade.profitLoss > 0 || (trade.isCorrect === true)
        );

        if (successfulTrades.length > 0) {
            console.log(`检测到 ${successfulTrades.length} 笔成功的交易`);
            // 可以在此处触发烟花效果
        }
    }

    async checkPredictionResults() {
        if (!this.lastPrediction) return;

        try {
            // 检查是否有相关的交易结果
            const response = await fetch('/api/all-trades', {
                headers: {
                    ...(localStorage.getItem('authToken') && {
                        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                    }),
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const allTrades = await response.json();
                const recentTrades = allTrades.slice(0, 10);

                // 查找与上次预测相关的交易
                const relatedTrade = recentTrades.find(trade => {
                    const tradeTime = new Date(trade.timestamp).getTime();
                    const predictionTime = new Date(this.lastPrediction.timestamp).getTime();

                    // 如果交易发生在预测之后且时间接近
                    return tradeTime > predictionTime - 60000 && // 预测前1分钟
                           tradeTime < predictionTime + 300000;     // 预测后5分钟
                });

                if (relatedTrade) {
                    this.handleTradeResult(relatedTrade);
                }
            }
        } catch (error) {
            console.error('检查预测结果失败:', error);
        }
    }

    handleTradeResult(trade) {
        // 检查预测是否成功
        const isSuccess = this.determinePredictionSuccess(trade);

        if (isSuccess && !this.fireworkTriggered) {
            this.triggerFireworks(trade);
            this.fireworkTriggered = true;

            // 重置触发标志，允许下次触发
            setTimeout(() => {
                this.fireworkTriggered = false;
            }, 30000); // 30秒内不再重复触发
        }

        // 更新统计信息
        this.updateStats(trade);
    }

    determinePredictionSuccess(trade) {
        // 这里应该根据实际的预测逻辑来判断
        // 目前使用简化的判断条件

        if (!this.lastPrediction) return false;

        // 假设:
        // - 预测为"BUY"，实际价格上涨则为成功
        // - 预测为"SELL"，实际价格下跌则为成功
        // - profitLoss > 0 表示盈利

        if (trade.profitLoss > 0) {
            return true; // 盈利即为成功
        }

        // 更复杂的判断逻辑可以根据实际预测系统调整
        return Math.random() > 0.5; // 模拟50%成功率
    }

    triggerFireworks(trade) {
        console.log('🎉 预测成功！触发烟花效果');

        // 保存交易信息用于烟花展示
        localStorage.setItem('successfulTrade', JSON.stringify({
            tradeId: trade._id,
            profit: trade.profitLoss,
            timestamp: new Date().toISOString()
        }));

        // 显示烟花容器
        const fireworkContainer = document.getElementById('fireworkContainer');
        fireworkContainer.style.display = 'block';

        // 创建烟花效果
        this.createFireworkEffect();

        // 播放庆祝音效
        this.playSuccessSound();

        // 显示成功消息
        this.showSuccessMessage(trade);

        // 3秒后隐藏烟花
        setTimeout(() => {
            fireworkContainer.style.display = 'none';
        }, 3000);
    }

    createFireworkEffect() {
        // 简单的CSS动画烟花效果
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fireworkExplosion {
                0% { transform: scale(0); opacity: 1; }
                50% { transform: scale(1.5); opacity: 0.8; }
                100% { transform: scale(2); opacity: 0; }
            }

            .firework-particle {
                position: absolute;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                animation: fireworkExplosion 1s ease-out forwards;
            }
        `;
        document.head.appendChild(style);

        // 在多个位置创建烟花粒子
        const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];
        const positions = [
            { left: '20%', top: '30%' },
            { left: '80%', top: '25%' },
            { left: '15%', top: '70%' },
            { left: '85%', top: '65%' },
            { left: '50%', top: '20%' }
        ];

        positions.forEach((pos, index) => {
            setTimeout(() => {
                const particle = document.createElement('div');
                particle.className = 'firework-particle';
                particle.style.left = pos.left;
                particle.style.top = pos.top;
                particle.style.backgroundColor = colors[index % colors.length];

                document.getElementById('fireworkContainer').appendChild(particle);

                // 移除粒子
                setTimeout(() => {
                    if (particle.parentNode) {
                        particle.parentNode.removeChild(particle);
                    }
                }, 1000);
            }, index * 200);
        });
    }

    playSuccessSound() {
        // 创建简单的音频反馈
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // 播放上升音调表示成功
            oscillator.frequency.setValueAtTime(523.25, audioContext.currentTime); // C5
            oscillator.frequency.setValueAtTime(659.25, audioContext.currentTime + 0.1); // E5
            oscillator.frequency.setValueAtTime(783.99, audioContext.currentTime + 0.2); // G5

            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.5);
        } catch (error) {
            console.log('音频播放不可用:', error);
        }
    }

    showSuccessMessage(trade) {
        // 显示预测成功的通知
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            padding: 2rem;
            border-radius: 15px;
            text-align: center;
            z-index: 1001;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            animation: slideUp 0.5s ease-out;
        `;

        notification.innerHTML = `
            <div style="font-size: 3rem; margin-bottom: 1rem;">🎉</div>
            <h2 style="margin: 0 0 1rem 0;">预测成功！</h2>
            <p style="margin: 0 0 1rem 0;">恭喜您做出了正确的交易决策</p>
            <p style="margin: 0; font-weight: bold;">盈利: +${trade.profitLoss?.toFixed(2) || '0'} U</p>
        `;

        document.body.appendChild(notification);

        // 点击关闭通知
        notification.addEventListener('click', () => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        });

        // 3秒后自动关闭
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }

    updateStats(trade) {
        // 更新统计数据显示
        const stats = {
            totalProfit: trade.profitLoss,
            successRate: 75, // 模拟数据
            accuracy: 85     // 模拟数据
        };

        // 可以在这里更新页面上的统计数据
        console.log('更新统计数据:', stats);
    }
}

// 初始化预测服务
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new PredictionService();
    });
} else {
    new PredictionService();
}

// 导出供其他模块使用
window.PredictionService = PredictionService;