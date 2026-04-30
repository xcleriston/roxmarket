import WebSocket from 'ws';
import { ENV } from '../config/env.js';
import { getUserActivityModel } from '../models/userHistory.js';
import User from '../models/user.js';
import Logger from '../utils/logger.js';
import { processDetectedTrade } from './tradeExecutor.js';
import fetchData from '../utils/fetchData.js';

const CLOB_WS_URL = ENV.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws';
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL || 'https://clob.polymarket.com';
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

// Tracking seen trades locally for extreme speed
const seenTradesLocal = new Set<string>();

// WebSocket connections per trader
const wsConnections = new Map<string, WebSocket>();

// Track WebSocket health - if it fails, use polling
let wsHealthy = true;
let wsFailures = 0;
const MAX_WS_FAILURES = 3;

const getUniqueTraders = async (): Promise<string[]> => {
    const users = await User.find({ 'config.traderAddress': { $exists: true, $ne: '' } });
    const addresses = users.map(u => u.config.traderAddress!.toLowerCase());
    const unique = Array.from(new Set(addresses));
    return unique;
};

const subscribeToTrades = (ws: WebSocket, traderAddress: string) => {
    // Subscribe to trade updates for specific address
    const subscribeMessage = {
        type: 'subscribe',
        channel: 'trades',
        params: {
            user: traderAddress.toLowerCase()
        }
    };
    ws.send(JSON.stringify(subscribeMessage));
};

const handleWebSocketMessage = async (data: any, traderAddress: string) => {
    try {
        const UserActivity = getUserActivityModel(traderAddress);
        
        // Parse trade data from WebSocket message
        const trade = data.data || data;
        if (!trade || !trade.transactionHash) return;

        const tradeId = trade.transactionHash;
        if (seenTradesLocal.has(tradeId)) return;

        const cutoffTimestamp = Date.now() / 1000 - TOO_OLD_TIMESTAMP * 3600;
        if (trade.timestamp < cutoffTimestamp) {
            seenTradesLocal.add(tradeId);
            return;
        }

        // Check DB as final fallback
        const exists = await UserActivity.findOne({ transactionHash: trade.transactionHash });
        if (exists) {
            seenTradesLocal.add(tradeId);
            const ageMinutes = (Date.now() / 1000 - trade.timestamp) / 60;
            if (ageMinutes < 15) {
                processDetectedTrade(exists, traderAddress).catch(e => 
                    Logger.error(`Retry execution failed: ${e.message}`)
                );
            }
            return;
        }

        const usdcSize = trade.usdcSize || (parseFloat(trade.size) * parseFloat(trade.price)) || 0;

        const newTrade = UserActivity({
            proxyWallet: trade.proxyWallet,
            traderAddress: traderAddress.toLowerCase(),
            timestamp: trade.timestamp * 1000,
            conditionId: trade.conditionId,
            type: trade.type,
            size: parseFloat(trade.size),
            usdcSize: usdcSize,
            transactionHash: trade.transactionHash,
            price: parseFloat(trade.price),
            asset: trade.asset,
            side: trade.side,
            outcomeIndex: trade.outcomeIndex,
            title: trade.title,
            slug: trade.slug,
            icon: trade.icon,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
            name: trade.name,
            bot: false,
            botExcutedTime: 0,
        });

        await newTrade.save();
        seenTradesLocal.add(tradeId);

        const detectLatency = (Date.now() / 1000) - (trade.timestamp);
        Logger.info(`⚡ [WS-INSTANT] New trade for ${traderAddress.slice(0, 6)}: ${trade.side} ${usdcSize.toFixed(2)} USDC (Detected in ${detectLatency.toFixed(3)}s via WebSocket)`);
        
        // Direct trigger for instant execution
        processDetectedTrade(newTrade.toObject(), traderAddress).catch(e => 
            Logger.error(`Direct execution failed: ${e.message}`)
        );
    } catch (error: any) {
        Logger.error(`Error processing WebSocket message: ${error.message}`);
    }
};

const createWebSocketConnection = (traderAddress: string): WebSocket => {
    const ws = new WebSocket(CLOB_WS_URL);
    
    ws.on('open', () => {
        Logger.info(`[WS] Connected to CLOB WebSocket for ${traderAddress.slice(0, 6)}`);
        subscribeToTrades(ws, traderAddress);
        wsFailures = 0; // Reset failure count on successful connection
    });

    ws.on('message', (data: WebSocket.Data) => {
        try {
            const message = JSON.parse(data.toString());
            handleWebSocketMessage(message, traderAddress);
        } catch (error) {
            Logger.error(`Error parsing WebSocket message: ${error}`);
        }
    });

    ws.on('error', (error: Error) => {
        Logger.error(`[WS] Error for ${traderAddress.slice(0, 6)}: ${error.message}`);
        wsFailures++;
        if (wsFailures >= MAX_WS_FAILURES) {
            Logger.warning(`[WS] Too many failures (${wsFailures}), switching to polling fallback`);
            wsHealthy = false;
        }
    });

    ws.on('close', () => {
        Logger.warning(`[WS] Connection closed for ${traderAddress.slice(0, 6)}, reconnecting in 5s...`);
        setTimeout(() => {
            if (wsHealthy) {
                const newWs = createWebSocketConnection(traderAddress);
                wsConnections.set(traderAddress, newWs);
            }
        }, 5000);
    });

    return ws;
};

// Polling fallback for when WebSocket fails
const pollTradesForTrader = async (traderAddress: string) => {
    try {
        const UserActivity = getUserActivityModel(traderAddress);
        const url = `${CLOB_HTTP_URL}/trades?maker=${traderAddress}&limit=50`;
        const trades = await fetchData(url);
        
        if (!trades || !Array.isArray(trades)) return;
        
        for (const trade of trades) {
            const tradeId = trade.transaction_hash || trade.transactionHash;
            if (!tradeId) continue;
            
            if (seenTradesLocal.has(tradeId)) continue;
            
            const cutoffTimestamp = Date.now() / 1000 - TOO_OLD_TIMESTAMP * 3600;
            const tradeTimestamp = trade.timestamp || trade.created_at;
            if (tradeTimestamp < cutoffTimestamp) {
                seenTradesLocal.add(tradeId);
                continue;
            }
            
            const exists = await UserActivity.findOne({ transactionHash: tradeId });
            if (exists) {
                seenTradesLocal.add(tradeId);
                continue;
            }
            
            const usdcSize = trade.usdc_size || (parseFloat(trade.size) * parseFloat(trade.price)) || 0;
            
            const newTrade = UserActivity({
                proxyWallet: trade.maker || trade.proxyWallet,
                traderAddress: traderAddress.toLowerCase(),
                timestamp: (tradeTimestamp || Date.now() / 1000) * 1000,
                conditionId: trade.condition_id,
                type: trade.type,
                size: parseFloat(trade.size),
                usdcSize: usdcSize,
                transactionHash: tradeId,
                price: parseFloat(trade.price),
                asset: trade.token_id,
                side: trade.side,
                outcomeIndex: trade.outcome_index,
                title: trade.market_title,
                slug: trade.market_slug,
                icon: trade.icon,
                eventSlug: trade.event_slug,
                outcome: trade.outcome,
                name: trade.outcome_name,
                bot: false,
                botExcutedTime: 0,
            });
            
            await newTrade.save();
            seenTradesLocal.add(tradeId);
            
            const detectLatency = (Date.now() / 1000) - tradeTimestamp;
            Logger.info(`📡 [POLLING] New trade for ${traderAddress.slice(0, 6)}: ${trade.side} ${usdcSize.toFixed(2)} USDC (Detected in ${detectLatency.toFixed(3)}s via polling)`);
            
            processDetectedTrade(newTrade.toObject(), traderAddress).catch(e => 
                Logger.error(`Direct execution failed: ${e.message}`)
            );
        }
    } catch (error: any) {
        Logger.error(`Error polling trades for ${traderAddress.slice(0, 6)}: ${error.message}`);
    }
};

let isRunning = true;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

export const stopWebSocketMonitor = () => {
    isRunning = false;
    Logger.info('WebSocket monitor shutdown requested...');
    
    // Close all connections
    wsConnections.forEach((ws, trader) => {
        ws.close();
        Logger.info(`[WS] Closed connection for ${trader.slice(0, 6)}`);
    });
    wsConnections.clear();
    
    // Stop polling
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
};

const websocketMonitor = async () => {
    Logger.success('🚀 Hybrid Trade Monitor Started (WebSocket + Polling Fallback)');
    
    // Cleanup local cache periodically
    setInterval(() => seenTradesLocal.clear(), 3600000);

    // Initial connection
    const traders = await getUniqueTraders();
    
    for (const trader of traders) {
        if (!wsConnections.has(trader) && wsHealthy) {
            const ws = createWebSocketConnection(trader);
            wsConnections.set(trader, ws);
        }
    }

    // Start polling as fallback (always runs, but minimal when WS is healthy)
    const startPolling = () => {
        if (pollingInterval) clearInterval(pollingInterval);
        
        const pollInterval = wsHealthy ? 10000 : 2000; // 10s if WS healthy, 2s if not
        
        pollingInterval = setInterval(async () => {
            if (!isRunning) return;
            
            const currentTraders = await getUniqueTraders();
            
            for (const trader of currentTraders) {
                if (!wsHealthy || !wsConnections.has(trader)) {
                    await pollTradesForTrader(trader);
                }
            }
        }, pollInterval);
        
        Logger.info(`[POLLING] Fallback polling started (${wsHealthy ? '10s' : '2s'} interval)`);
    };
    
    startPolling();

    // Periodically check for new traders and WS health
    const checkInterval = setInterval(async () => {
        if (!isRunning) {
            clearInterval(checkInterval);
            return;
        }

        const currentTraders = await getUniqueTraders();
        
        // Add new traders to WebSocket if healthy
        if (wsHealthy) {
            for (const trader of currentTraders) {
                if (!wsConnections.has(trader)) {
                    Logger.info(`[WS] Adding new trader: ${trader.slice(0, 6)}`);
                    const ws = createWebSocketConnection(trader);
                    wsConnections.set(trader, ws);
                }
            }

            // Remove inactive traders
            for (const [trader, ws] of wsConnections.entries()) {
                if (!currentTraders.includes(trader)) {
                    Logger.info(`[WS] Removing inactive trader: ${trader.slice(0, 6)}`);
                    ws.close();
                    wsConnections.delete(trader);
                }
            }
        }
        
        // Restart polling with new interval if WS health changed
        if (wsHealthy && wsFailures === 0) {
            startPolling();
        }
    }, 30000); // Check every 30 seconds

    Logger.info(`[WS] Monitoring ${wsConnections.size} traders via WebSocket`);
    Logger.info(`[POLLING] Polling fallback active`);
};

export default websocketMonitor;
