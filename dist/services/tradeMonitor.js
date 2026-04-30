import { ENV } from '../config/env.js';
import { getUserActivityModel } from '../models/userHistory.js';
import User from '../models/user.js';
import fetchData from '../utils/fetchData.js';
import Logger from '../utils/logger.js';
import { processDetectedTrade } from './tradeExecutor.js';
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
// Tracking seen trades locally for extreme speed (bypass DB read for de-dupe)
const seenTradesLocal = new Set();
const getUniqueTraders = async () => {
    const users = await User.find({ 'config.traderAddress': { $exists: true, $ne: '' }, 'config.enabled': true });
    const addresses = users.map(u => u.config.traderAddress.toLowerCase());
    return Array.from(new Set(addresses));
};
const fetchTradeDataForTrader = async (address) => {
    try {
        const UserActivity = getUserActivityModel(address);
        // FETCH FROM /trades endpoint with CACHE BUSTING for <200ms latency
        // Note: 'userAddress' is the real-time endpoint, 'user' is often stale.
        const apiUrl = `https://data-api.polymarket.com/trades?userAddress=${address.toLowerCase()}&limit=5&t=${Date.now()}`;
        const activities = await fetchData(apiUrl);
        if (!Array.isArray(activities) || activities.length === 0) {
            return;
        }
        const cutoffTimestamp = Date.now() / 1000 - TOO_OLD_TIMESTAMP * 3600;
        // Process activities in reverse (oldest first) to ensure correct sequence
        for (const activity of [...activities].reverse()) {
            const tradeId = activity.transactionHash || activity.id;
            if (seenTradesLocal.has(tradeId))
                continue;
            if (activity.timestamp < cutoffTimestamp) {
                seenTradesLocal.add(tradeId);
                continue;
            }
            // Check DB as final fallback
            const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash }).exec();
            if (exists) {
                seenTradesLocal.add(tradeId);
                continue;
            }
            const newTrade = UserActivity({
                proxyWallet: activity.proxyWallet,
                timestamp: activity.timestamp * 1000,
                conditionId: activity.conditionId,
                type: activity.type,
                size: activity.size,
                usdcSize: activity.usdcSize,
                transactionHash: activity.transactionHash,
                price: activity.price,
                asset: activity.asset,
                side: activity.side,
                outcomeIndex: activity.outcomeIndex,
                title: activity.title,
                slug: activity.slug,
                icon: activity.icon,
                eventSlug: activity.eventSlug,
                outcome: activity.outcome,
                name: activity.name,
                bot: false,
                botExcutedTime: 0,
            });
            await newTrade.save();
            seenTradesLocal.add(tradeId);
            const detectLatency = (Date.now() / 1000) - (activity.timestamp);
            Logger.info(`⚡ [FAST-DETECT] New trade for ${address.slice(0, 6)}: ${activity.side} ${activity.usdcSize} USDC (Detected in ${detectLatency.toFixed(2)}s)`);
            // DIRECT TRIGGER: Bypass tradeExecutor's 100ms DB polling loop
            processDetectedTrade(newTrade.toObject(), address).catch(e => Logger.error(`Direct execution failed: ${e.message}`));
        }
    }
    catch (error) {
        if (error.response?.status === 429) {
            Logger.debug(`[MONITOR] Rate limited for ${address.slice(0, 6)}`);
        }
        else {
            Logger.error(`Error fetching data for ${address.slice(0, 6)}: ${error.message}`);
        }
    }
};
let isRunning = true;
export const stopTradeMonitor = () => {
    isRunning = false;
};
const tradeMonitor = async () => {
    Logger.success('🚀 Hyper-Fast Trade Monitor Started (Target: <200ms)');
    // Cleanup local cache periodically to prevent memory leaks
    setInterval(() => seenTradesLocal.clear(), 3600000);
    while (isRunning) {
        const startCycle = Date.now();
        const traders = await getUniqueTraders();
        if (traders.length > 0) {
            // Parallel poll with small jitter to avoid burst 429s
            await Promise.all(traders.map(async (addr, idx) => {
                await new Promise(r => setTimeout(r, idx * 20)); // Reduced jitter to 20ms
                return fetchTradeDataForTrader(addr);
            }));
        }
        const elapsed = Date.now() - startCycle;
        // Target sub-200ms polling interval
        const sleepTime = Math.max(50, 100 - elapsed);
        await new Promise(r => setTimeout(r, sleepTime));
    }
    Logger.info('Trade monitor stopped');
};
export default tradeMonitor;
