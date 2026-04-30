import { ethers } from 'ethers';
import { ENV } from '../config/env.js';
import { Activity } from '../models/userHistory.js';
import User from '../models/user.js';
import Logger from '../utils/logger.js';
import fetchData from '../utils/fetchData.js';
const EXCHANGE_ABI = [
    "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)"
];
const POLYMARKET_EXCHANGE_ADDR = ENV.POLYMARKET_EXCHANGE_ADDR;
// Global cache for trader proxy addresses
const proxyCache = new Map();
export const startChainMonitor = async () => {
    if (!ENV.WSS_RPC_URL) {
        Logger.error('WSS_RPC_URL not configured. Real-time chain monitoring disabled.');
        return;
    }
    try {
        Logger.info('Initializing High-Speed Monitor...');
        const provider = new ethers.providers.WebSocketProvider(ENV.WSS_RPC_URL);
        // Handle provider errors specifically to prevent Uncaught Exceptions
        provider.on("error", (e) => {
            const isRateLimit = e.message?.includes('429') || e.code?.toString() === '429';
            const isNotFound = e.message?.includes('404') || e.code?.toString() === '404';
            const waitTime = isRateLimit ? 30000 : (isNotFound ? 60000 : 15000);
            if (isNotFound) {
                Logger.error(`🚫 RPC Endpoint Not Found (404): Check your WSS_RPC_URL. Retrying in 60s...`);
            }
            else {
                Logger.error(`${isRateLimit ? '🚫 RPC Rate Limit (429)' : '❌ WebSocket Error'}: Retrying in ${waitTime / 1000}s...`);
            }
            provider.destroy();
            setTimeout(startChainMonitor, waitTime);
        });
        const contract = new ethers.Contract(POLYMARKET_EXCHANGE_ADDR, EXCHANGE_ABI, provider);
        Logger.success('⚡ Connected to Polygon WebSocket for real-time monitoring');
        contract.on("OrderFilled", async (...args) => {
            try {
                const event = args[args.length - 1];
                const eventArgs = event.args || {};
                const { maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled } = eventArgs;
                // Safe tx hash extraction — location varies between ethers v5 versions
                const txHash = event?.transactionHash || event?.log?.transactionHash || event?.hash;
                if (!maker || !taker || !txHash) {
                    Logger.warning('⚠️ Incomplete event data received, skipping...');
                    return;
                }
                const makerAddr = maker.toLowerCase();
                const takerAddr = taker.toLowerCase();
                const monitoredTraders = await User.distinct('config.traderAddress', { 'config.enabled': true });
                const monitoredLower = monitoredTraders.map((t) => t.toLowerCase());
                // Fetch Proxy addresses for traders (cached globally in the service)
                for (const trader of monitoredLower) {
                    if (!proxyCache.has(trader)) {
                        try {
                            const profile = await fetchData(`https://data-api.polymarket.com/user?address=${trader}`);
                            if (profile?.proxyWallet) {
                                proxyCache.set(trader, profile.proxyWallet.toLowerCase());
                                Logger.info(`[CHAIN] Cached Proxy for ${trader}: ${profile.proxyWallet}`);
                            }
                            else {
                                proxyCache.set(trader, null);
                            }
                        }
                        catch (e) { }
                    }
                }
                const allTargets = [...monitoredLower, ...Array.from(proxyCache.values()).filter(v => v !== null)];
                const isMakerMonitored = allTargets.includes(makerAddr);
                const isTakerMonitored = allTargets.includes(takerAddr);
                if (isMakerMonitored || isTakerMonitored) {
                    const traderByProxy = Array.from(proxyCache.entries()).find(([t, p]) => p === makerAddr || p === takerAddr);
                    const finalTrader = traderByProxy ? traderByProxy[0] : (monitoredLower.includes(makerAddr) ? makerAddr : takerAddr);
                    Logger.header(`⚡ ON-CHAIN TRADE DETECTED: ${finalTrader.slice(0, 8)}...`);
                    // AssetId 0 = USDC. If makerAssetId is 0, maker is sending USDC → buying tokens
                    const isBuy = (makerAddr === finalTrader || proxyCache.get(finalTrader) === makerAddr)
                        ? (makerAssetId.toString() === '0')
                        : (takerAssetId.toString() === '0');
                    const condTokenId = (makerAddr === finalTrader || proxyCache.get(finalTrader) === makerAddr)
                        ? (isBuy ? takerAssetId : makerAssetId)
                        : (isBuy ? makerAssetId : takerAssetId);
                    const isLimit = (makerAddr === finalTrader || proxyCache.get(finalTrader) === makerAddr);
                    const activityData = {
                        traderAddress: finalTrader,
                        timestamp: Date.now(),
                        transactionHash: txHash,
                        conditionId: condTokenId.toString(),
                        type: 'TRADE',
                        orderType: isLimit ? 'LIMIT' : 'MARKET',
                        side: isBuy ? 'BUY' : 'SELL',
                        usdcSize: (makerAddr === finalTrader || proxyCache.get(finalTrader) === makerAddr)
                            ? Number(ethers.utils.formatUnits(isBuy ? makerAmountFilled : takerAmountFilled, 6))
                            : Number(ethers.utils.formatUnits(isBuy ? takerAmountFilled : makerAmountFilled, 6)),
                        bot: false,
                        processedBy: [],
                        isChainDetected: true
                    };
                    const exists = await Activity.findOne({ transactionHash: activityData.transactionHash });
                    if (!exists) {
                        const newActivity = await Activity.create(activityData);
                        Logger.success(`🚀 Instant copy triggered for ${finalTrader.slice(0, 6)} via Blockchain Event`);
                        // Async enrichment
                        (async () => {
                            try {
                                const metaUrl = `https://gamma-api.polymarket.com/events?condition_id=${activityData.conditionId}`;
                                const metadata = await fetchData(metaUrl);
                                if (Array.isArray(metadata) && metadata.length > 0) {
                                    const m = metadata[0];
                                    await Activity.updateOne({ _id: newActivity._id }, {
                                        $set: {
                                            title: m.title,
                                            slug: m.slug,
                                            eventSlug: m.eventSlug,
                                            icon: m.icon
                                        }
                                    });
                                }
                            }
                            catch (e) {
                                Logger.debug(`[CHAIN] Metadata enrichment failed for ${activityData.conditionId}: ${e}`);
                            }
                        })();
                    }
                }
            }
            catch (err) {
                Logger.error(`Chain event processing error: ${err}`);
            }
        });
        // Keep-alive heartbeat handled by provider.on("error") above
    }
    catch (error) {
        Logger.error('Immediate Chain Monitor error: ' + error);
        setTimeout(startChainMonitor, 15000);
    }
};
