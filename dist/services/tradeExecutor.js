import { ENV } from '../config/env.js';
import { Activity } from '../models/userHistory.js';
import User from '../models/user.js';
import fetchData from '../utils/fetchData.js';
import getMyBalance from '../utils/getMyBalance.js';
import postOrder from '../utils/postOrder.js';
import Logger from '../utils/logger.js';
import { broadcastTrade } from '../utils/push.js';
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PREVIEW_MODE = process.env.PREVIEW_MODE === 'true';
import { getClobClientForUser, findProxyWallet } from '../utils/createClobClient.js';
// Check daily loss per user (wallet)
const checkDailyLoss = async (proxyWallet, chatId) => {
    // Legacy logic simplified for multi-user
    return true; // TODO: Implement per-user tracking if needed
};
const readUnprocessedTrades = async () => {
    // Find trades that haven't been completed by everyone
    return await Activity.find({ bot: false, type: 'TRADE' }).lean();
};
export const processDetectedTrade = async (trade, traderAddressParam) => {
    const traderAddress = (traderAddressParam || trade.traderAddress || "").toLowerCase();
    if (!traderAddress)
        return;
    // Find all users following this trader in COPY mode
    const followers = await User.find({
        'config.traderAddress': { $regex: new RegExp(`^${traderAddress}$`, 'i') },
        'config.enabled': true,
        'config.mode': { $in: ['COPY', 'MIRROR_100'] }
    });
    if (followers.length === 0) {
        // No active followers, mark trade as done to stop polling
        await Activity.updateOne({ _id: trade._id }, { $set: { bot: true } });
        return;
    }
    for (const follower of followers) {
        const followerId = follower._id.toString();
        // Skip if this follower already processed this trade
        if (trade.processedBy && trade.processedBy.includes(followerId)) {
            continue;
        }
        Logger.header(`👤 FOLLOWER: ${followerId} copying ${traderAddress.slice(0, 6)}...`);
        try {
            const clobClient = await getClobClientForUser(follower);
            if (!clobClient) {
                Logger.error(`[${followerId}] Could not initialize CLOB client (possibly signature error) - skipping trade`);
                await Activity.updateOne({ _id: trade._id }, { $set: { [`followerStatuses.${followerId}`]: { status: 'ERRO (CLIENT)', details: 'Falha ao inicializar CLOB client (assinatura inválida?)', timestamp: new Date() } } });
                continue;
            }
            const proxyWallet = follower.wallet?.address;
            if (!proxyWallet) {
                Logger.warning(`[${followerId}] No wallet configured - skipping`);
                continue;
            }
            // Mark user as processing immediately (atomic-ish update)
            await Activity.updateOne({ _id: trade._id }, { $addToSet: { processedBy: followerId } });
            // Calculate E2E Latency
            const polymarketTime = trade.timestamp > 2000000000 ? trade.timestamp / 1000 : trade.timestamp;
            const latencySeconds = (Date.now() / 1000) - (polymarketTime / 1000);
            Logger.trade(followerId, trade.side || 'UNKNOWN', {
                asset: trade.asset,
                side: trade.side,
                amount: trade.usdcSize,
                price: trade.price,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                transactionHash: trade.transactionHash,
                latency: latencySeconds,
            });
            if (PREVIEW_MODE) {
                Logger.info(`🔍 PREVIEW MODE — trade logged for user ${followerId} but NOT executed`);
            }
            else {
                const proxyInfo = await findProxyWallet(follower);
                const targetAddr = proxyInfo?.address || follower.wallet?.address || '';
                const my_positions = await fetchData(`https://data-api.polymarket.com/positions?user=${targetAddr}`);
                const user_positions = await fetchData(`https://data-api.polymarket.com/positions?user=${traderAddress}`);
                const my_position = my_positions.find((position) => position.conditionId === trade.conditionId);
                const user_position = user_positions.find((position) => position.conditionId === trade.conditionId);
                const [balEoa, balProxy, clobBalance] = await Promise.all([
                    getMyBalance(follower.wallet?.address || ''),
                    targetAddr !== follower.wallet?.address ? getMyBalance(targetAddr) : Promise.resolve(0),
                    getMyBalance(clobClient)
                ]);
                const my_balance = balEoa + balProxy + clobBalance;
                const user_balance = user_positions.reduce((total, pos) => {
                    return total + (pos.currentValue || 0);
                }, 0);
                Logger.info(`[${followerId}] Consolidating Balance: $${my_balance.toFixed(2)} (EOA: ${balEoa}, Proxy: ${balProxy}, CLOB: ${clobBalance})`);
                Logger.balance(my_balance, user_balance, followerId);
                // Execute the trade with FOLLOWER'S config
                await postOrder(clobClient, trade.side === 'BUY' ? 'buy' : 'sell', my_position, user_position, trade, my_balance, followerId, follower.config, // Pass individual user config
                my_positions, // Pass all positions for exposure calculation
                targetAddr // Pass proxyAddress
                );
            }
        }
        catch (error) {
            Logger.error(`Error processing trade for follower ${followerId}: ${error}`);
        }
        Logger.separator();
    }
    // After attempting all followers, check if we should mark the trade as completely processed
    const latestTrade = await Activity.findById(trade._id).lean();
    if (latestTrade) {
        const stillMissing = followers.filter(f => !latestTrade.processedBy.includes(f.chatId || f._id.toString()));
        if (stillMissing.length === 0) {
            await Activity.updateOne({ _id: trade._id }, { $set: { bot: true } });
            Logger.info(`✅ Trade ${trade.transactionHash?.slice(0, 8)} fully processed for all ${followers.length} followers.`);
            // Notify web followers via Push
            await broadcastTrade(traderAddress, trade);
        }
    }
};
// Track executor state
let isRunning = true;
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};
const tradeExecutor = async () => {
    Logger.success('Multi-User Trade executor ready');
    if (PREVIEW_MODE) {
        Logger.warning('🔍 PREVIEW MODE ACTIVE — trades will be logged but NOT executed');
    }
    let lastCheck = Date.now();
    while (isRunning) {
        const trades = await readUnprocessedTrades();
        if (trades.length > 0) {
            Logger.clearLine();
            Logger.header(`⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} DETECTED`);
            for (const trade of trades) {
                await processDetectedTrade(trade);
            }
            lastCheck = Date.now();
        }
        else {
            if (Date.now() - lastCheck > 1000) {
                // Get count of active unique traders being monitored across all users
                const uniqueTradersCount = (await User.distinct('config.traderAddress', { 'config.enabled': true })).length;
                Logger.waiting(uniqueTradersCount);
                lastCheck = Date.now();
            }
        }
        if (!isRunning)
            break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    Logger.info('Trade executor stopped');
};
export default tradeExecutor;
