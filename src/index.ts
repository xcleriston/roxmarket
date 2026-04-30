import connectDB, { closeDB } from './config/db.js';
import { ENV } from './config/env.js';
import createClobClient from './utils/createClobClient.js';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor.js';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor.js';
import { startChainMonitor } from './services/chainMonitor.js';
import { startTpSlMonitor } from './services/tpSlMonitor.js';
import { startArbitrageMonitor } from './services/arbitrageMonitor.js';
import { startServer } from './server/index.js';
import TelegramServer from './telegram/server.js';
import Logger from './utils/logger.js';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck.js';

// Handle Railway port
const PORT = parseInt(process.env.PORT || '3000');

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`🌪️ UNHANDLED REJECTION at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    // Check if error is related to network/RPC limits (429 or frame errors)
    const isNetworkError = error.message.includes('429') || 
                          error.message.includes('Unexpected server response: 429') ||
                          error.message.includes('Unexpected server response: 404') ||
                          error.message.includes('Unexpected server response: 409') ||
                          error.message.includes('Invalid WebSocket frame') || 
                          error.message.includes('ECONNRESET') ||
                          error.message.includes('ETIMEDOUT');

    if (isNetworkError) {
        Logger.error(`⚠️ Network Resiliency: Suppression of crash for error: ${error.message}`);
        return; // Don't kill the process for network hiccups
    }

    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for other uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        Logger.info('Starting Polycopy SaaS Multi-User System...');
        
        await connectDB();

        // One-time Migration: Convert ARBITRAGE users to COPY
        try {
            const User = (await import('./models/user.js')).default;
            const migrationResult = await User.updateMany(
                { "config.mode": "ARBITRAGE" },
                { $set: { "config.mode": "COPY", "step": "ready" } }
            );
            if (migrationResult.modifiedCount > 0) {
                Logger.info(`[MIGRATION] Successfully converted ${migrationResult.modifiedCount} users from ARBITRAGE to COPY.`);
            }
        } catch (err) {
            Logger.error(`[MIGRATION] Failed to migrate ARBITRAGE users: ${err}`);
        }
        
        // Telegram Bot (non-blocking)
        if (ENV.TELEGRAM_BOT_TOKEN) {
            const telegramServer = new TelegramServer(ENV.TELEGRAM_BOT_TOKEN);
            telegramServer.startPolling().catch(err => {
                Logger.error(`Telegram Bot Critical Error: ${err.message || err}`);
            });
        }

        Logger.info('Starting trade monitor...');
        tradeMonitor();

        Logger.info('Starting real-time chain monitor...');
        startChainMonitor();

        Logger.info('Starting TP/SL monitor...');
        startTpSlMonitor();

        Logger.info('Starting trade executor...');
        tradeExecutor();

        // Logger.info('Starting arbitrage/hedge bot...');
        // startArbitrageMonitor();

        // Start web UI + API server
        await startServer(PORT);
        
        Logger.success('All services initialized 🚀');
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
