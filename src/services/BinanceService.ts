import { AxiosInstance } from 'axios';
import { IPriceData } from '../models/PriceData';
import WebSocket, { ClientOptions } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createAxiosInstance } from '../utils/axiosInstance';

export interface BinanceTicker {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  lastQty: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
}

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
  ignore: string;
}

export interface ProxyConfig {
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

export class BinanceService {
  private readonly BASE_URL = 'https://api.binance.com/api/v3';
  private readonly FAPI_BASE_URL = 'https://fapi.binance.com/fapi/v1';
  private readonly WS_URL = 'wss://stream.binance.com:9443';
  private readonly SYMBOL = 'BTCUSDT';
  private axiosInstance: AxiosInstance;
  private fapiAxiosInstance: AxiosInstance;
  private wsClient?: WebSocket;
  private wsConnected = false;
  private priceListeners: ((price: number) => void)[] = [];
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(proxyConfig?: ProxyConfig) {
    // 使用封装的axios实例创建函数
    this.axiosInstance = createAxiosInstance(this.BASE_URL, proxyConfig);
    this.fapiAxiosInstance = createAxiosInstance(this.FAPI_BASE_URL, proxyConfig);

    // 初始化WebSocket连接
    this.initWebSocket(proxyConfig);
  }

  /**
   * 初始化WebSocket连接
   */
  /**
   * 初始化WebSocket连接 (连接币安事件合约标的指数实时流)
   */
  private initWebSocket(proxyConfig?: ProxyConfig): void {
    try {
      // 检查是否有代理配置
      const proxyUrl = process.env.HTTPS_PROXY || (proxyConfig ? `http://${proxyConfig.host}:${proxyConfig.port}` : undefined);
      const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
      // 切换为事件合约标的指数实时WebSocket流
      this.wsClient = new WebSocket(`wss://fstream.binance.com/ws/${this.SYMBOL.toLowerCase()}@indexPrice`, {
        agent: proxyAgent, // 传入代理
        pingTimeout: 10000,
        pingInterval: 20000
      } as ClientOptions);

      this.wsClient.onopen = () => {
        console.log('币安事件合约标的指数 WebSocket 连接已建立');
        this.wsConnected = true;
        this.reconnectAttempts = 0;
      };

      this.wsClient.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          // 标的指数流中价格字段为 p，普通ticker中为 c
          const rawPrice = data.p || data.c;
          if (rawPrice) {
            const price = parseFloat(rawPrice);
            // 通知所有监听器
            this.priceListeners.forEach(listener => listener(price));
          }
        } catch (error) {
          console.error('WebSocket消息解析错误:', error);
        }
      };

      this.wsClient.onclose = () => {
        console.log('WebSocket连接已关闭');
        this.wsConnected = false;
        this.handleReconnect();
      };

      this.wsClient.onerror = (error) => {
        console.error('WebSocket错误:', error);
        this.wsConnected = false;
      };

    } catch (error) {
      console.error('WebSocket初始化失败:', error);
    }
  }

  /**
   * 处理WebSocket重连
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000; // 指数退避

      console.log(`WebSocket重连尝试 ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}, ${delay}ms后重连...`);

      setTimeout(() => {
        this.initWebSocket();
      }, delay);
    } else {
      console.error('WebSocket重连次数已达上限，停止重连');
    }
  }

  /**
   * 获取当前BTC价格（全量切换为币安事件合约BTC综合标的指数价格）
   */
  async getCurrentPrice(): Promise<BinanceTicker> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.fapiAxiosInstance.get('/premiumIndex', {
          params: { symbol: this.SYMBOL }
        });
        const d = response.data;
        const indexPriceStr = String(d.indexPrice || d.markPrice || '78000');
        return {
          symbol: d.symbol || this.SYMBOL,
          priceChange: '0',
          priceChangePercent: '0',
          weightedAvgPrice: indexPriceStr,
          prevClosePrice: indexPriceStr,
          lastPrice: indexPriceStr,
          lastQty: '0',
          bidPrice: indexPriceStr,
          bidQty: '0',
          askPrice: indexPriceStr,
          askQty: '0',
          openPrice: indexPriceStr,
          highPrice: d.markPrice || indexPriceStr,
          lowPrice: d.markPrice || indexPriceStr,
          volume: '0',
          quoteVolume: '0',
          openTime: d.time || Date.now(),
          closeTime: d.time || Date.now(),
          firstId: 0,
          lastId: 0,
          count: 0
        };
      } catch (error: any) {
        console.error(`获取币安事件合约指数价格失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1))); // 指数退避
        }
      }
    }
    throw new Error('无法获取实时事件合约指数价格数据，所有重试都失败了');
  }

  /**
   * 获取K线数据（全量切换为币安事件合约BTC综合标的指数K线数据）
   */
  async getKlines(interval: string = '5m', limit: number = 250, startTime?: number, endTime?: number): Promise<BinanceKline[]> {
    return this.getIndexPriceKlines(this.SYMBOL, interval, limit, startTime, endTime);
  }

  /**
   * 保留原生现货K线数据获取接口（备用）
   */
  async getSpotKlines(interval: string = '1m', limit: number = 100, startTime?: number, endTime?: number): Promise<BinanceKline[]> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.axiosInstance.get('/klines', {
          params: {
            symbol: this.SYMBOL,
            interval,
            limit,
            ...(startTime && { startTime }),
            ...(endTime && { endTime })
          }
        });

        return response.data.map((kline: any[]) => ({
          openTime: kline[0],
          open: kline[1],
          high: kline[2],
          low: kline[3],
          close: kline[4],
          volume: kline[5],
          closeTime: kline[6],
          quoteAssetVolume: kline[7],
          numberOfTrades: kline[8],
          takerBuyBaseAssetVolume: kline[9],
          takerBuyQuoteAssetVolume: kline[10],
          ignore: kline[11]
        }));
      } catch (error: any) {
        console.error(`获取现货K线数据失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
      }
    }
    throw new Error('无法获取现货K线数据，所有重试都失败了');
  }

  /**
   * 获取币安事件合约标的指数K线数据 (Index Price Klines)
   * 接口: GET https://fapi.binance.com/fapi/v1/indexPriceKlines
   */
  async getIndexPriceKlines(pair: string = 'BTCUSDT', interval: string = '5m', limit: number = 250, startTime?: number, endTime?: number): Promise<BinanceKline[]> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.fapiAxiosInstance.get('/indexPriceKlines', {
          params: {
            pair,
            interval,
            limit,
            ...(startTime && { startTime }),
            ...(endTime && { endTime })
          }
        });

        return response.data.map((kline: any[]) => ({
          openTime: kline[0],
          open: kline[1],
          high: kline[2],
          low: kline[3],
          close: kline[4],
          volume: kline[5] || '0',
          closeTime: kline[6],
          quoteAssetVolume: kline[7] || '0',
          numberOfTrades: kline[8] || 0,
          takerBuyBaseAssetVolume: kline[9] || '0',
          takerBuyQuoteAssetVolume: kline[10] || '0',
          ignore: kline[11] || '0'
        }));
      } catch (error: any) {
        console.error(`获取事件合约指数K线失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)));
        }
      }
    }
    throw new Error('无法获取事件合约指数K线数据，所有重试都失败了');
  }

  /**
   * 获取币安事件合约标的指数最新价格与结算预估
   * 接口: GET https://fapi.binance.com/fapi/v1/premiumIndex
   */
  async getIndexPrice(symbol: string = 'BTCUSDT'): Promise<{ symbol: string; indexPrice: number; markPrice: number; estimatedSettlePrice: number; time: number }> {
    try {
      const response = await this.fapiAxiosInstance.get('/premiumIndex', {
        params: { symbol }
      });
      const data = response.data;
      return {
        symbol: data.symbol,
        indexPrice: parseFloat(data.indexPrice),
        markPrice: parseFloat(data.markPrice),
        estimatedSettlePrice: parseFloat(data.estimatedSettlePrice),
        time: data.time
      };
    } catch (error: any) {
      console.error('获取事件合约指数价格失败:', error.message);
      throw error;
    }
  }

  /**
   * 转换币安数据为内部格式
   */
  convertToPriceData(ticker: BinanceTicker): Partial<IPriceData> {
    return {
      symbol: ticker.symbol,
      timestamp: new Date(ticker.closeTime),
      price: parseFloat(ticker.lastPrice),
      volume: parseFloat(ticker.volume),
      high: parseFloat(ticker.highPrice),
      low: parseFloat(ticker.lowPrice),
      open: parseFloat(ticker.openPrice),
      close: parseFloat(ticker.lastPrice)
    };
  }

  /**
   * 转换K线数据为内部格式
   */
  convertKlinesToPriceData(klines: BinanceKline[]): Partial<IPriceData>[] {
    return klines.map(kline => ({
      symbol: this.SYMBOL,
      timestamp: new Date(kline.openTime),
      price: parseFloat(kline.close),
      volume: parseFloat(kline.volume),
      high: parseFloat(kline.high),
      low: parseFloat(kline.low),
      open: parseFloat(kline.open),
      close: parseFloat(kline.close)
    }));
  }

  /**
   * 获取历史数据用于初始化
   */
  async getHistoricalData(minutes: number = 60): Promise<Partial<IPriceData>[]> {
    const klines = await this.getKlines('1m', minutes);
    return this.convertKlinesToPriceData(klines);
  }

  /**
   * 获取市场深度
   */
  async getOrderBook(limit: number = 10): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    try {
      const response = await this.axiosInstance.get('/depth', {
        params: {
          symbol: this.SYMBOL,
          limit
        }
      });

      return {
        bids: response.data.bids.map((bid: string[]) => [parseFloat(bid[0]), parseFloat(bid[1])]),
        asks: response.data.asks.map((ask: string[]) => [parseFloat(ask[0]), parseFloat(ask[1])])
      };
    } catch (error: any) {
      console.error('获取订单簿失败:', error.message);
      return { bids: [], asks: [] };
    }
  }

  /**
   * 添加价格监听器
   */
  addPriceListener(callback: (price: number) => void): void {
    this.priceListeners.push(callback);
  }

  /**
   * 移除价格监听器
   */
  removePriceListener(callback: (price: number) => void): void {
    const index = this.priceListeners.indexOf(callback);
    if (index > -1) {
      this.priceListeners.splice(index, 1);
    }
  }

  /**
   * 获取WebSocket连接状态
   */
  isWebSocketConnected(): boolean {
    return this.wsConnected;
  }

  /**
   * 使用WebSocket获取实时价格（备选方案）
   */
  async getCurrentPriceWebSocket(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.wsConnected) {
        reject(new Error('WebSocket未连接'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('获取价格超时'));
      }, 5000);

      const listener = (price: number) => {
        clearTimeout(timeout);
        this.removePriceListener(listener);
        resolve(price);
      };

      this.addPriceListener(listener);
    });
  }

  /**
   * 检查API连接状态
   */
  async checkConnection(): Promise<boolean> {
    // 首先检查WebSocket连接
    if (this.wsConnected) {
      return true;
    }

    // 如果WebSocket不可用，检查REST API
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.axiosInstance.get('/ping');
        return true;
      } catch (error: any) {
        console.error(`币安API连接失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    return false;
  }
}