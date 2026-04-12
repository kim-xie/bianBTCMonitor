import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

interface ProxyConfig {
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

/**
 * 创建并配置axios实例
 * @param baseURL 基础URL
 * @param proxyConfig 代理配置（可选）
 * @returns 配置好的axios实例
 */
export function createAxiosInstance(baseURL: string = '', proxyConfig?: ProxyConfig): AxiosInstance {
  // 检查是否有代理配置
  const proxyUrl = proxyConfig ? `http://${proxyConfig.host}:${proxyConfig.port}` : undefined;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  // 创建axios实例并配置
  const axiosInstance = axios.create({
    baseURL,
    timeout: 30000, // 30秒超时
    httpsAgent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/json'
    },
  });

  // 添加请求拦截器用于调试
  axiosInstance.interceptors.request.use(
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
  axiosInstance.interceptors.response.use(
    (response) => {
      console.log(`响应成功: ${response.status}`);
      return response;
    },
    (error) => {
      console.error('响应错误:', error.response?.status, error.message);
      return Promise.reject(error);
    }
  );

  return axiosInstance;
}

// 导出默认的axios实例（无代理）
export const axiosInstance = createAxiosInstance();