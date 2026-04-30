import WebSocket from 'ws';
import { ENV } from '../config/env.js';
import { getUserActivityModel } from '../models/userHistory.js';
import User from '../models/user.js';
import Logger from '../utils/logger.js';
import { processDetectedTrade } from './tradeExecutor.js';

const CLOB_WS_URL = ENV.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws';
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

// Tracking seen trades locally for extreme speed
const seenTradesLocal = new Set<string>();

// WebSocket connections per trader
const wsConnections = new Map<string, WebSocket>();

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
    });

    ws.on('close', () => {
        Logger.warning(`[WS] Connection closed for ${traderAddress.slice(0, 6)}, reconnecting in 5s...`);
        setTimeout(() => {
            const newWs = createWebSocketConnection(traderAddress);
            wsConnections.set(traderAddress, newWs);
        }, 5000);
    });

    return ws;
};

let isRunning = true;

export const stopWebSocketMonitor = () => {
    isRunning = false;
    Logger.info('WebSocket monitor shutdown requested...');
    
    // Close all connections
    wsConnections.forEach((ws, trader) => {
        ws.close();
        Logger.info(`[WS] Closed connection for ${trader.slice(0, 6)}`);
    });
    wsConnections.clear();
};

const websocketMonitor = async () => {
    Logger.success('🚀 Instant WebSocket Trade Monitor Started (<50ms latency)');
    
    // Cleanup local cache periodically
    setInterval(() => seenTradesLocal.clear(), 3600000);

    // Initial connection
    const traders = await getUniqueTraders();
    
    for (const trader of traders) {
        if (!wsConnections.has(trader)) {
            const ws = createWebSocketConnection(trader);
            wsConnections.set(trader, ws);
        }
    }

    // Periodically check for new traders
    const checkInterval = setInterval(async () => {
        if (!isRunning) {
            clearInterval(checkInterval);
            return;
        }

        const currentTraders = await getUniqueTraders();
        
        // Add new traders
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
    }, 30000); // Check every 30 seconds

    Logger.info(`[WS] Monitoring ${wsConnections.size} traders via WebSocket`);
};

export default websocketMonitor;
