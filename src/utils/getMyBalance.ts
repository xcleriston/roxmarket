import { ethers } from 'ethers';
import { ClobClient, AssetType } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import Logger from './logger.js';

const PUSD_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const RPC_LIST = [
    ENV.RPC_URL,
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
    'https://polygon-mainnet.g.allthatnode.com/full/mainnet',
    'https://polygon-rpc.com',
].filter(Boolean);

const balanceCache = new Map<string, { balance: number, timestamp: number }>();
const BALANCE_CACHE_TTL = 2000; // 2 seconds (matching roxmarket)

/**
 * Fetches USDC balance.
 * Supports both ClobClient (for internal Polymarket balance)
 * and address (for on-chain RPC balance).
 */
const getMyBalance = async (clientOrAddress: ClobClient | string): Promise<number> => {
    if (!clientOrAddress) return 0;
    
    try {
        if (typeof clientOrAddress === 'object') {
            // CLOB client - internal Polymarket balance
            try {
                const resp = await clientOrAddress.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                const balance = parseFloat(ethers.utils.formatUnits(resp.balance || '0', 6));
                console.log(`[BALANCE] CLOB client returned: $${balance.toFixed(2)}`);
                return balance;
            } catch (e) {
                console.error('[BALANCE] CLOB fetch failed:', (e as any).message);
                return 0; // CLOB unavailable - continue to RPC fallback if address available
            }
        }

        const address = clientOrAddress;
        if (!address || typeof address !== 'string') return 0;
        
        const cacheKey = address.toLowerCase();
        const cached = balanceCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < BALANCE_CACHE_TTL) {
            console.log(`[BALANCE] Cache hit for ${address.slice(0,8)}: $${cached.balance.toFixed(2)}`);
            return cached.balance;
        }

        const pusdAddr = ENV.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        let finalBalance = 0;
        let lastError: string = '';

        for (const rpc of RPC_LIST) {
            try {
                const provider = new ethers.providers.StaticJsonRpcProvider({ url: rpc, skipFetchSetup: true }, 137);
                const contract = new ethers.Contract(pusdAddr, PUSD_ABI, provider);
                const bal = await Promise.race([
                    contract.balanceOf(address),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 5000))
                ]);
                finalBalance = parseFloat(ethers.utils.formatUnits(bal, 6));
                
                console.log(`[BALANCE] RPC ${rpc.slice(0,30)}... -> $${finalBalance.toFixed(2)} for ${address.slice(0,8)}`);
                if (finalBalance >= 0) {
                    break; // Success
                }
            } catch (rpcErr) {
                lastError = String((rpcErr as any).message || 'Unknown error');
                continue;
            }
        }

        if (finalBalance < 0) {
            console.warn(`[BALANCE] All RPCs failed. Last error: ${lastError}`);
            finalBalance = 0;
        }

        balanceCache.set(cacheKey, { balance: finalBalance, timestamp: Date.now() });
        return finalBalance;
    } catch (e: any) {
        console.error('[BALANCE] Fatal error:', e.message);
        return 0;
    }
};

export default getMyBalance;
