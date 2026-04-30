import { ENV } from '../config/env.js';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory.js';
import User from '../models/user.js';
import fetchData from '../utils/fetchData.js';
import Logger from '../utils/logger.js';
import { processDetectedTrade } from './tradeExecutor.js';

const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

// Tracking seen trades locally for extreme speed (bypass DB read for de-dupe)
const seenTradesLocal = new Set<string>();

const getUniqueTraders = async (): Promise<string[]> => {
    // REQUISITO CRÍTICO: Monitorar qualquer um que tenha traderAddress, ignorando travas de status se necessário
    const users = await User.find({ 'config.traderAddress': { $exists: true, $ne: '' } });
    const addresses = users.map(u => u.config.traderAddress!.toLowerCase());
    const unique = Array.from(new Set(addresses));
    
    if (unique.length > 0) {
        Logger.debug(`[MONITOR] Active Traders: ${unique.join(', ')}`);
    }
    return unique;
};

const fetchTradeDataForTrader = async (address: string) => {
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
        
        Logger.debug(`[MONITOR-${address.slice(0,6)}] Fetched ${activities?.length || 0} activities from API`);
        if (activities?.length > 0) {
            const latestAge = (Date.now() / 1000 - activities[0].timestamp);
            Logger.debug(`[MONITOR-${address.slice(0,6)}] Latest activity age: ${latestAge.toFixed(1)}s, cutoff: ${(TOO_OLD_TIMESTAMP*3600).toFixed(0)}s`);
        }
        
        // Process activities in reverse (oldest first) to ensure correct sequence
        for (const activity of [...activities].reverse()) {
            const tradeId = activity.transactionHash || activity.id;
            if (seenTradesLocal.has(tradeId)) continue;
            
            if (activity.timestamp < cutoffTimestamp) {
                seenTradesLocal.add(tradeId);
                continue;
            }

            // Check DB as final fallback
            const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash });
            if (exists) {
                seenTradesLocal.add(tradeId);
                // CRITICAL FIX: If it's very recent (e.g., last 15 mins), try processing it anyway 
                // in case it was missed by this specific follower during a restart.
                // The executor has its own de-dupe logic (processedBy array).
                const ageMinutes = (Date.now() / 1000 - activity.timestamp) / 60;
                if (ageMinutes < 15) {
                    processDetectedTrade(exists, address).catch(e => 
                        Logger.error(`Retry execution failed: ${e.message}`)
                    );
                }
                continue;
            }

            const usdcSize = activity.usdcSize || (parseFloat(activity.size) * parseFloat(activity.price)) || 0;

            const newTrade = UserActivity({
                proxyWallet: activity.proxyWallet,
                traderAddress: address.toLowerCase(), // BUG FIX: necessário para processDetectedTrade encontrar seguidores
                timestamp: activity.timestamp * 1000,
                conditionId: activity.conditionId,
                type: activity.type,
                size: parseFloat(activity.size),
                usdcSize: usdcSize,
                transactionHash: activity.transactionHash,
                price: parseFloat(activity.price),
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
                processedBy: [], // BUG FIX: inicializar como array vazio para rastrear quem processou
                followerStatuses: {}, // Track detailed execution status per follower
            });

            await newTrade.save();
            seenTradesLocal.add(tradeId);
            
            const detectLatency = (Date.now() / 1000) - (activity.timestamp);
            Logger.info(`⚡ [FAST-DETECT] New trade for ${address.slice(0, 6)}: ${activity.side} ${usdcSize.toFixed(2)} USDC (Detected in ${detectLatency.toFixed(2)}s)`);
            
            // DIRECT TRIGGER: Bypass tradeExecutor's 100ms DB polling loop
            processDetectedTrade(newTrade.toObject(), address).catch(e => 
                Logger.error(`Direct execution failed: ${e.message}`)
            );
        }
    } catch (error: any) {
        if (error.response?.status === 429) {
            Logger.debug(`[MONITOR] Rate limited for ${address.slice(0,6)}`);
        } else {
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
