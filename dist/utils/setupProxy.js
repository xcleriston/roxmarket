import axios from 'axios';
// @ts-ignore
import { HttpsProxyAgent } from 'https-proxy-agent';
// @ts-ignore
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ENV } from '../config/env.js';
import Logger from './logger.js';
/**
 * Configure global axios to use a proxy if configured in ENV.
 * This ensures @polymarket/clob-client (which uses axios internally)
 * routes traffic through the proxy to avoid geoblocking.
 */
export const setupProxy = async () => {
    const proxyUrl = ENV.HTTPS_PROXY;
    if (proxyUrl) {
        try {
            Logger.info(`[PROXY] Configuring global proxy: ${proxyUrl.split('@')[1] || proxyUrl}`);
            let agent;
            if (proxyUrl.startsWith('socks')) {
                agent = new SocksProxyAgent(proxyUrl);
            }
            else {
                agent = new HttpsProxyAgent(proxyUrl);
            }
            // Apply to global axios defaults
            axios.defaults.httpsAgent = agent;
            axios.defaults.httpAgent = agent;
            // Also set environment variables that many libraries respect
            process.env.HTTPS_PROXY = proxyUrl;
            process.env.HTTP_PROXY = proxyUrl;
            Logger.info(`[PROXY] Global axios proxy configured successfully (${proxyUrl.startsWith('socks') ? 'SOCKS' : 'HTTP'}).`);
        }
        catch (error) {
            Logger.error(`[PROXY] Failed to configure proxy: ${error}`);
        }
    }
    else {
        Logger.info('[PROXY] No proxy configured. API calls will use default network routing.');
    }
};
export default setupProxy;
