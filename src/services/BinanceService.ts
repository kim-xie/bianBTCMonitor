import axios, { AxiosInstance } from 'axios';
import { IPriceData } from '../models/PriceData';
import WebSocket, { ClientOptions } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

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
  private readonly WS_URL = 'wss://stream.binance.com:9443';
  private readonly SYMBOL = 'BTCUSDT';
  private axiosInstance: AxiosInstance;
  private wsClient?: WebSocket;
  private wsConnected = false;
  private priceListeners: ((price: number) => void)[] = [];
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(proxyConfig?: ProxyConfig) {
    // 检查是否有代理配置
    const proxyUrl = proxyConfig ? `http://${proxyConfig.host}:${proxyConfig.port}` : undefined;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    // 创建axios实例并配置代理
    const axiosConfig: any = {
      baseURL: this.BASE_URL,
      timeout: 30000, // 增加超时时间
      httpsAgent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };

    this.axiosInstance = axios.create(axiosConfig);

    // 添加请求拦截器用于调试
    this.axiosInstance.interceptors.request.use(
      (config) => {
        console.log(`发起请求: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('请求配置错误:', error);
        return Promise.reject(error);
      }
    );

    // 添加响应拦截器用于调试
    this.axiosInstance.interceptors.response.use(
      (response) => {
        console.log(`响应成功: ${response.status}`);
        return response;
      },
      (error) => {
        console.error('响应错误:', error.response?.status, error.message);
        return Promise.reject(error);
      }
    );

    // 初始化WebSocket连接
    this.initWebSocket(proxyConfig);
  }

  /**
   * 初始化WebSocket连接
   */
  private initWebSocket(proxyConfig?: ProxyConfig): void {
    try {
      // 检查是否有代理配置
      const proxyUrl = process.env.HTTPS_PROXY || (proxyConfig ? `http://${proxyConfig.host}:${proxyConfig.port}` : undefined);
      const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
      this.wsClient = new WebSocket(`${this.WS_URL}/ws/${this.SYMBOL.toLowerCase()}@ticker`, {
        agent: proxyAgent, // 传入代理
        pingTimeout: 10000, // 关键：如果 10 秒内没响应，视为断开，触发重连
        pingInterval: 20000 // 每 20 秒主动发一次 ping (可选，保持链路活跃)
      } as ClientOptions);

      this.wsClient.onopen = () => {
        console.log('币安 WebSocket 连接已建立');
        this.wsConnected = true;
        this.reconnectAttempts = 0;
      };

      this.wsClient.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          const price = parseFloat(data.c); // 最新价格

          // 通知所有监听器
          this.priceListeners.forEach(listener => listener(price));
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
   * 获取当前BTC价格
   */
  async getCurrentPrice(): Promise<BinanceTicker> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.axiosInstance.get('/ticker/24hr', {
          params: { symbol: this.SYMBOL }
        });
        return response.data;
      } catch (error: any) {
        console.error(`获取币安价格失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // 指数退避
        }
      }
    }
    throw new Error('无法获取实时价格数据，所有重试都失败了');
  }

  /**
   * 获取K线数据
   */
  async getKlines(interval: string = '1m', limit: number = 100): Promise<BinanceKline[]> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await this.axiosInstance.get('/klines', {
          params: {
            symbol: this.SYMBOL,
            interval,
            limit
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
        console.error(`获取K线数据失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
      }
    }
    throw new Error('无法获取K线数据，所有重试都失败了');
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