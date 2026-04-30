import { ethers } from 'ethers';
import { AssetType } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import Logger from './logger.js';
const PUSD_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
];
const RPC_LIST = [
    ENV.RPC_URL,
    'https://polygon-rpc.com',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://1rpc.io/matic',
    'https://polygon.llamarpc.com'
].filter(Boolean);
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 2000; // 2 seconds (matching roxmarket)
/**
 * Fetches pUSD (Polymarket USD) balance.
 * Supports both ClobClient (accurate for CLOB funds)
 * and wallet address (fast RPC check for EOA/Proxy).
 */
const getMyBalance = async (clientOrAddress) => {
    try {
        const cacheKey = typeof clientOrAddress === 'string' ? clientOrAddress : 'clob_client';
        const cached = balanceCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < BALANCE_CACHE_TTL) {
            return cached.balance;
        }
        let finalBalance = 0;
        if (typeof clientOrAddress === 'string') {
            const address = clientOrAddress;
            const pusdAddr = ENV.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            for (const rpc of RPC_LIST) {
                try {
                    const provider = new ethers.providers.JsonRpcProvider({
                        url: rpc,
                        skipFetchSetup: true
                    }, 137);
                    const pusd = new ethers.Contract(pusdAddr, PUSD_ABI, provider);
                    const balance = await pusd.balanceOf(address);
                    finalBalance = parseFloat(ethers.utils.formatUnits(balance, 6));
                    if (finalBalance > 0) {
                        Logger.info(`[BALANCE] Successfully fetched $${finalBalance} pUSD for ${address.slice(0, 6)} via ${rpc}`);
                    }
                    break; // Success
                }
                catch (rpcErr) {
                    Logger.warning(`[BALANCE] RPC ${rpc} failed for ${address.slice(0, 6)}: ${rpcErr instanceof Error ? rpcErr.message : 'Unknown'}`);
                    continue;
                }
            }
        }
        else {
            const resp = await clientOrAddress.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const rawBalance = resp.balance || "0";
            finalBalance = parseFloat(ethers.utils.formatUnits(rawBalance, 6));
        }
        balanceCache.set(cacheKey, { balance: finalBalance, timestamp: Date.now() });
        return finalBalance;
    }
    catch (e) {
        Logger.error(`[BALANCE] Critical failure for ${typeof clientOrAddress === 'string' ? clientOrAddress : 'Client'}: ${e.message}`);
        return 0;
    }
};
export default getMyBalance;
