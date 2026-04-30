import { ClobClient, OrderType, Side } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User.js';
import { Activity, getUserActivityModel } from '../models/userHistory.js';
import User from '../models/user.js';
import Logger from './logger.js';
import { calculateOrderSize, getTradeMultiplier, CopyStrategy, CopyStrategyConfig } from '../config/copyStrategy.js';
import telegram from './telegram.js';
import fetchData from './fetchData.js';

const SLIPPAGE_TOLERANCE = parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.05');

// Polymarket minimum order sizes (USD)
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;

const extractOrderError = (response: any): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;
    
    // Try to find the error message in the response structure
    let error = response.error || response.errorMsg || response.message || response.error_msg;
    
    // Check nested structures if needed
    if (!error && response.data) {
        error = response.data.error || response.data.message || response.data.errorMsg;
    }

    if (error) {
        let errorStr = String(error);
        // Add helpful hints for common errors
        if (errorStr.toLowerCase().includes('invalid signature')) {
            errorStr += " (Check if your Proxy Wallet and Private Key match your Polymarket profile)";
        }
        return errorStr;
    }
    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) return false;
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance') || lower.includes('insufficient balance');
};

const recordStatus = async (activityId: string, followerId: string, status: string, details?: string, extra?: Record<string, any>) => {
    try {
        console.log(`[RECORD_STATUS] ${followerId} -> ${status}: ${details || ''} ${extra ? JSON.stringify(extra) : ''}`);
        await Activity.updateOne(
            { _id: activityId },
            { $set: { [`followerStatuses.${followerId}`]: { status, details, timestamp: new Date(), ...extra } } }
        );
    } catch (e) {
        Logger.error(`Failed to record status for ${followerId}: ${e}`);
    }
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: any,
    my_balance: number,
    followerId: string,
    userConfig: any,
    my_positions: UserPositionInterface[] = [],
    proxyAddress?: string
) => {
    const isMirror100 = userConfig.mode === 'MIRROR_100';
    const config = {
        strategy: isMirror100 ? CopyStrategy.PERCENTAGE : ((userConfig.strategy as CopyStrategy) || CopyStrategy.PERCENTAGE),
        copySize: isMirror100 ? 100.0 : (userConfig.copySize || 10.0),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '500'),
        minOrderSizeUSD: isMirror100 ? 0 : 1.0,
        tradeMultiplier: 1.0,
        buyAtMin: isMirror100 ? true : !!userConfig.buyAtMin,
        ...userConfig
    };

    const tradePrice = trade.price;
    const tradeSizeUSD = trade.usdcSize;

    if (!isMirror100) {
        if (condition === 'buy' && config.copyBuy === false) {
            await recordStatus(trade._id, followerId, 'PULADO (LADO)', 'Compra desativada nas configurações');
            return;
        }
        if (condition === 'sell' && config.copySell === false) {
            await recordStatus(trade._id, followerId, 'PULADO (LADO)', 'Venda desativada nas configurações');
            return;
        }

        if (config.minPrice > 0 && tradePrice < config.minPrice) {
            await recordStatus(trade._id, followerId, 'PULADO (PREÇO)', `Preço $${tradePrice} abaixo do mínimo $${config.minPrice}`);
            return;
        }
        if (config.maxPrice > 0 && tradePrice > config.maxPrice) {
            await recordStatus(trade._id, followerId, 'PULADO (PREÇO)', `Preço $${tradePrice} acima do máximo $${config.maxPrice}`);
            return;
        }

        if (config.minTradeSize > 0 && tradeSizeUSD < config.minTradeSize) {
            await recordStatus(trade._id, followerId, 'PULADO (TAMANHO)', `Tamanho $${tradeSizeUSD} abaixo do mínimo $${config.minTradeSize}`);
            return;
        }
        if (config.maxTradeSize > 0 && tradeSizeUSD > config.maxTradeSize) {
            await recordStatus(trade._id, followerId, 'PULADO (TAMANHO)', `Tamanho $${tradeSizeUSD} acima do máximo $${config.maxTradeSize}`);
            return;
        }
    }

    let effectiveCondition = condition;
    if (config.reverseCopy === true) {
        effectiveCondition = condition === 'buy' ? 'sell' : 'buy';
    }

    const slippage = config.slippage || SLIPPAGE_TOLERANCE;
    const retryLimit = parseInt(process.env.RETRY_LIMIT || '3');

    if (effectiveCondition === 'buy') {
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;
        const orderCalc = calculateOrderSize(config, trade.usdcSize, my_balance, currentPositionValue);

        if (config.buyAtMin && orderCalc.finalAmount > 0 && orderCalc.finalAmount < MIN_ORDER_SIZE_USD) {
            orderCalc.finalAmount = MIN_ORDER_SIZE_USD;
        }

        const minOrderCheck = config.mode === 'MIRROR_100' ? 0 : (config.minOrderSizeUSD || 0);
        if (orderCalc.finalAmount < (minOrderCheck - 0.001)) {
            await recordStatus(trade._id, followerId, 'PULADO (ESTRATÉGIA)', orderCalc.reasoning);
            return;
        }

        if (!isMirror100) {
            const totalExposure = my_positions.reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
            if (config.maxExposure > 0 && (totalExposure + orderCalc.finalAmount) > config.maxExposure) {
                await recordStatus(trade._id, followerId, 'PULADO (EXPOSIÇÃO)', 'Exposição máxima atingida');
                return;
            }
        }

        let remaining = orderCalc.finalAmount;
        let retry = 0;

        while (remaining > 0.05 && retry < retryLimit) {
            try {
                const orderBook = await clobClient.getOrderBook(trade.asset);
                if (!orderBook.asks || orderBook.asks.length === 0) {
                    await recordStatus(trade._id, followerId, 'PULADO (LIQUIDEZ)', 'Sem ofertas no book');
                    break;
                }

                const bestAsk = orderBook.asks[0];
                if (!isMirror100 && parseFloat(bestAsk.price) - slippage > trade.price) {
                    await recordStatus(trade._id, followerId, 'PULADO (SLIPPAGE)', 'Slippage muito alto');
                    break;
                }

                const orderSizeUSD = Math.min(remaining, parseFloat(bestAsk.size) * parseFloat(bestAsk.price));
                const orderTokens = orderSizeUSD / parseFloat(bestAsk.price);

                const isLimit = (trade as any).orderType === 'LIMIT' || orderSizeUSD < 1.0;
                let resp: any;

                if (isLimit) {
                    resp = await clobClient.createAndPostOrder({
                        tokenID: trade.asset,
                        price: config.mode === 'MIRROR_100' ? 0.99 : parseFloat(bestAsk.price),
                        side: Side.BUY,
                        size: orderTokens,
                    }, { tickSize: "0.01" });
                } else {
                    resp = await clobClient.createAndPostMarketOrder({
                        tokenID: trade.asset,
                        amount: orderSizeUSD,
                        side: Side.BUY,
                    }, { tickSize: "0.01" });
                }

                if (resp.success) {
                    retry = 0;
                    remaining -= orderSizeUSD;
                    await recordStatus(trade._id, followerId, 'SUCESSO', `Comprado $${orderSizeUSD.toFixed(2)}`, {
                        myEntryAmount: orderSizeUSD,
                        myEntryPrice: parseFloat(bestAsk.price),
                        myExecutedAt: new Date(),
                    });
                    telegram.tradeExecuted(followerId, 'BUY', orderSizeUSD, parseFloat(bestAsk.price), trade.slug || trade.title);
                } else {
                    const err = extractOrderError(resp);
                    if (isInsufficientBalanceOrAllowanceError(err)) {
                        await recordStatus(trade._id, followerId, 'ERRO (SALDO)', err);
                        break;
                    }
                    retry++;
                    if (retry >= retryLimit) await recordStatus(trade._id, followerId, 'ERRO (API)', err);
                }
            } catch (e: any) {
                Logger.error(`[BUY] Loop error: ${e.message}`);
                retry++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    } else if (effectiveCondition === 'sell') {
        if (!my_position) return;
        let trader_sell_percent = 1.0;
        if (user_position) trader_sell_percent = trade.size / (user_position.size + trade.size);
        
        let remaining = my_position.size * trader_sell_percent;
        if (remaining < MIN_ORDER_SIZE_TOKENS) return;

        let retry = 0;
        while (remaining > 0.05 && retry < retryLimit) {
            try {
                const orderBook = await clobClient.getOrderBook(trade.asset);
                if (!orderBook.bids || orderBook.bids.length === 0) break;

                const bestBid = orderBook.bids[0];
                const sellSize = Math.min(remaining, parseFloat(bestBid.size));
                
                const resp = await clobClient.createAndPostOrder({
                    tokenID: trade.asset,
                    price: config.mode === 'MIRROR_100' ? 0.01 : parseFloat(bestBid.price),
                    side: Side.SELL,
                    size: sellSize,
                }, { tickSize: "0.01" });

                if (resp.success) {
                    retry = 0;
                    remaining -= sellSize;
                    await recordStatus(trade._id, followerId, 'SUCESSO', `Vendido tokens`, {
                        myEntryAmount: sellSize * parseFloat(bestBid.price),
                        myEntryPrice: parseFloat(bestBid.price),
                        myExecutedAt: new Date(),
                    });
                } else {
                    retry++;
                }
            } catch (e: any) {
                retry++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
};

export default postOrder;
