// @ts-nocheck
import axios from 'axios';
import http from 'http';
import https from 'https';
import { ENV } from '../config/env.js';
import { retry } from './retry.js';
import Logger from './logger.js';
// Connection pooling to reduce handshake latency
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
// BUG FIX: import condicional — socks-proxy-agent só é carregado se USE_PROXY=true
// Isso evita crash no boot em produção onde o pacote pode não estar presente
let socksAgent = null;
if (process.env.USE_PROXY === 'true') {
    try {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:40000');
        console.log('🛡️ [NETWORK] SOCKS5 Proxy ativado');
    }
    catch (e) {
        console.warn('[NETWORK] USE_PROXY=true mas socks-proxy-agent não encontrado. Proxy desativado.');
    }
}
const cache = new Map();
const CACHE_TTL = 10000; // 10 seconds (for metadata only)
const fetchData = async (url) => {
    // ONLY cache static metadata like tick-size or market list. 
    // NEVER cache activity or trades.
    const isCacheable = (url.includes('tick-size') || url.includes('markets')) && !url.includes('activity') && !url.includes('trades');
    if (isCacheable && cache.has(url)) {
        const cached = cache.get(url);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }
    }
    const retries = ENV.NETWORK_RETRY_LIMIT;
    const timeout = ENV.REQUEST_TIMEOUT_MS;
    const data = await retry(async () => {
        const response = await axios.get(url, {
            timeout,
            httpAgent,
            httpsAgent: socksAgent || httpsAgent,
            headers: {
                // Browser-like User-Agent to bypass restrictive Polymarket API caching (matching roxmarket)
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
            family: 4,
        });
        return response.data;
    }, {
        retries,
        onRetry: (error, attempt) => {
            const message = axios.isAxiosError(error) ? error.code || error.message : String(error);
            if (message === 'ERR_BAD_REQUEST') {
                // Don't log full error for 429
                return;
            }
            Logger.warning(`Network error (attempt ${attempt}/${retries + 1}): ${message}. Retrying...`);
        },
    });
    if (isCacheable && data) {
        cache.set(url, { data, timestamp: Date.now() });
    }
    return data;
};
export default fetchData;
