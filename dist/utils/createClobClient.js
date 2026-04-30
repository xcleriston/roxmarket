// @ts-nocheck
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import Logger from './logger.js';
import fetchData from './fetchData.js';
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL || 'https://clob.polymarket.com/';
// Preserve originals so error handler can safely restore them
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
// BUG FIX: import condicional — só ativa proxy se USE_PROXY=true
// Evita crash em produção onde socks-proxy-agent/undici podem não estar no PATH do Node
if (process.env.USE_PROXY === 'true') {
    try {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        const { fetch: undiciFetch } = await import('undici');
        console.log('🛡️ [NETWORK] Enabling SOCKS5 Proxy Tunnel...');
        const socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:40000');
        // @ts-ignore
        global.fetch = (url, options = {}) => {
            // @ts-ignore
            return undiciFetch(url, { ...options, dispatcher: socksAgent });
        };
    }
    catch (e) {
        console.warn('[NETWORK] USE_PROXY=true mas pacotes de proxy não encontrados. Usando fetch padrão.');
    }
}
const clobClientCache = new Map();
export const findProxyWallet = async (eoaOrUser, retries = 3) => {
    const eoa = typeof eoaOrUser === 'string' ? eoaOrUser : eoaOrUser?.wallet?.address;
    if (!eoa)
        return null;
    // BUG FIX: Use manual proxy if explicitly set in user object (even without isProxyVerified)
    // This ensures existing wallets with proxyAddress work correctly
    if (typeof eoaOrUser === 'object' && eoaOrUser?.wallet?.proxyAddress) {
        return {
            address: eoaOrUser.wallet.proxyAddress,
            type: eoaOrUser.wallet.signatureType || SignatureTypeV2.POLY_GNOSIS_SAFE
        };
    }
    for (let i = 0; i < retries; i++) {
        try {
            const url = `https://gamma-api.polymarket.com/public-profile?address=${eoa.toLowerCase()}`;
            const profile = await fetchData(url);
            if (profile && profile.proxyWallet && profile.proxyWallet.toLowerCase() !== eoa.toLowerCase()) {
                const proxy = profile.proxyWallet;
                const wType = (profile.walletType || "").toLowerCase();
                let type = SignatureTypeV2.POLY_GNOSIS_SAFE;
                if (wType.includes('magic') || wType.includes('email') || wType.includes('google')) {
                    type = SignatureTypeV2.POLY_PROXY;
                }
                Logger.info(`[PROXY] Detected Proxy ${proxy} (Type: ${type}) for ${eoa.slice(0, 6)}`);
                return { address: proxy, type };
            }
            // If we got a valid response but no proxy, it's an EOA
            return null;
        }
        catch (e) {
            if (i === retries - 1) {
                Logger.error(`[PROXY] Error detecting proxy for ${eoa} after ${retries} attempts: ${e}`);
            }
            else {
                Logger.warning(`[PROXY] Attempt ${i + 1} failed for ${eoa}, retrying...`);
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }
    return null;
};
export const getClobClientForUser = async (user) => {
    if (!user.wallet?.privateKey)
        return null;
    const cacheKey = user.wallet.address.toLowerCase();
    if (clobClientCache.has(cacheKey))
        return clobClientCache.get(cacheKey);
    let proxyInfo = null;
    if (user.wallet.proxyAddress && user.wallet.signatureType && user.wallet.isProxyVerified) {
        proxyInfo = {
            address: user.wallet.proxyAddress,
            type: user.wallet.signatureType
        };
    }
    else {
        proxyInfo = await findProxyWallet(user);
    }
    try {
        // IMPORTANT: Never use Builder creds for user balance/dashboard info
        const client = await createClobClient(user.wallet.privateKey, proxyInfo?.address, proxyInfo?.type, false);
        clobClientCache.set(cacheKey, client);
        return client;
    }
    catch (err) {
        Logger.error(`[CLOB] Failed to create client for ${user.wallet.address.slice(0, 6)}: ${err}`);
        return null;
    }
};
const createClobClient = async (customPk, proxyAddress, forcedSigType, useBuilderCreds = false) => {
    const host = CLOB_HTTP_URL;
    const pk = (customPk || PRIVATE_KEY);
    if (!pk)
        throw new Error('PRIVATE_KEY is required to create CLOB client');
    const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(ENV.RPC_URL)
    });
    const signatureType = forcedSigType ?? (proxyAddress ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA);
    let client = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: walletClient,
        signatureType,
    });
    try {
        // Use Builder credentials ONLY if explicitly requested and available
        if (useBuilderCreds && ENV.POLY_BUILDER_API_KEY && ENV.POLY_BUILDER_SECRET && ENV.POLY_BUILDER_PASSPHRASE) {
            Logger.info(`[CLOB] Using Builder credentials for ${account.address.slice(0, 6)}`);
            return new ClobClient({
                host,
                chain: Chain.POLYGON,
                signer: walletClient,
                creds: {
                    key: ENV.POLY_BUILDER_API_KEY,
                    secret: ENV.POLY_BUILDER_SECRET,
                    passphrase: ENV.POLY_BUILDER_PASSPHRASE,
                },
                signatureType,
            });
        }
        // Standard path: Use derived or existing credentials for the user
        const creds = await client.createOrDeriveApiKey();
        return new ClobClient({
            host,
            chain: Chain.POLYGON,
            signer: walletClient,
            creds,
            signatureType,
        });
    }
    catch (err) {
        // Restore console to log the error properly
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        if (err.message?.includes('invalid signature') || err.message?.includes('401')) {
            throw new Error(`Invalid Signature: The derived key does not match. Signer: ${account.address}, Proxy: ${proxyAddress || 'None'}, Type: ${signatureType}. Check if your Proxy is correctly linked on Polymarket.`);
        }
        throw err;
    }
};
export default createClobClient;
