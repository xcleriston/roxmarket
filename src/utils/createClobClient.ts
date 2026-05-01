// @ts-nocheck
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import Logger from './logger.js';
import fetchData from './fetchData.js';

import { SocksProxyAgent } from 'socks-proxy-agent';
import { fetch as undiciFetch } from 'undici';

const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL || 'https://clob.polymarket.com/';

// Preserve originals so error handler can safely restore them
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Setup global fetch proxy for the entire process (affects @polymarket/clob-client-v2)
if (process.env.USE_PROXY === 'true') {
    console.log('🛡️ [NETWORK] Enabling SOCKS5 Proxy Tunnel...');
    const socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:40000');
    
    // @ts-ignore
    global.fetch = (url, options = {}) => {
        // @ts-ignore
        return undiciFetch(url, {
            ...options,
            dispatcher: socksAgent
        } as any);
    };
}

const clobClientCache: Map<string, ClobClient> = new Map();

export interface ProxyInfo {
    address: string;
    type: SignatureTypeV2;
}

export const findProxyWallet = async (eoaOrUser: string | any, retries = 3): Promise<ProxyInfo | null> => {
    const eoa = typeof eoaOrUser === 'string' ? eoaOrUser : eoaOrUser?.wallet?.address;
    if (!eoa) return null;

    // Use manual proxy if explicitly set in user object (and not just placeholder)
    if (typeof eoaOrUser === 'object' && eoaOrUser?.wallet?.proxyAddress && eoaOrUser?.wallet?.isProxyVerified) {
        return { 
            address: eoaOrUser.wallet.proxyAddress, 
            type: (eoaOrUser.wallet.signatureType as SignatureTypeV2) || SignatureTypeV2.POLY_GNOSIS_SAFE
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
        } catch (e) {
            if (i === retries - 1) {
                Logger.error(`[PROXY] Error detecting proxy for ${eoa} after ${retries} attempts: ${e}`);
            } else {
                Logger.warning(`[PROXY] Attempt ${i + 1} failed for ${eoa}, retrying...`);
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }
    return null;
};

export const clearClobCache = (address: string) => {
    clobClientCache.delete(address.toLowerCase());
};

export const getClobClientForUser = async (user: any): Promise<ClobClient | null> => {
    if (!user.wallet?.privateKey) return null;

    const cacheKey = user.wallet.address.toLowerCase();
    // 1. Cache em memoria - mais rapido
    if (clobClientCache.has(cacheKey)) return clobClientCache.get(cacheKey)!;

    // 2. FIX: usar credenciais salvas no banco (derivadas em sessao anterior)
    //    Isso evita chamar /auth/api-key no boot ou a cada trade
    const saved = user.wallet?.clobCreds;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (saved?.key && saved?.secret && saved?.passphrase && 
        saved?.derivedAt && (Date.now() - saved.derivedAt) < SEVEN_DAYS) {
        try {
            const pk = (user.wallet.privateKey.startsWith('0x') 
                ? user.wallet.privateKey : '0x' + user.wallet.privateKey) as (`0x${string}`);
            const account = privateKeyToAccount(pk);
            const walletClient = createWalletClient({ account, chain: polygon, transport: http(ENV.RPC_URL) });
            const signatureType = (user.wallet.signatureType as SignatureTypeV2) || SignatureTypeV2.EOA;
            const client = new ClobClient({
                host: CLOB_HTTP_URL, chain: Chain.POLYGON, signer: walletClient,
                creds: { key: saved.key, secret: saved.secret, passphrase: saved.passphrase },
                signatureType,
            });
            clobClientCache.set(cacheKey, client);
            Logger.debug('[CLOB] Using saved credentials for ' + account.address.slice(0,8));
            return client;
        } catch (e) {
            Logger.warning('[CLOB] Failed to build client from saved creds, will re-derive: ' + e);
        }
    }

    // 3. Sem creds salvas: derivar agora (chamada a /auth/api-key)
    //    Isso so deve ocorrer na primeira vez que o usuario loga, nao no boot
    let proxyInfo: ProxyInfo | null = null;
    if (user.wallet.proxyAddress && user.wallet.signatureType && user.wallet.isProxyVerified) {
        proxyInfo = { address: user.wallet.proxyAddress, type: user.wallet.signatureType as SignatureTypeV2 };
    } else {
        proxyInfo = await findProxyWallet(user);
    }

    try {
        Logger.info('[CLOB] Deriving new API key for ' + user.wallet.address.slice(0,8) + ' (first time only)');
        const client = await createClobClient(user.wallet.privateKey, proxyInfo?.address, proxyInfo?.type, false);
        clobClientCache.set(cacheKey, client);

        // Salvar creds no banco para nao derivar novamente
        try {
            const rawCreds = (client as any).creds || (client as any).config?.creds;
            if (rawCreds?.key) {
                const User = (await import('../models/user.js')).default;
                await User.updateOne(
                    { _id: user._id },
                    { $set: { 'wallet.clobCreds': { ...rawCreds, derivedAt: Date.now() } } }
                );
                Logger.success('[CLOB] Credentials saved to DB - no more /auth/api-key calls');
            }
        } catch (saveErr) {
            Logger.warning('[CLOB] Could not save creds to DB: ' + saveErr);
        }
        return client;
    } catch (err) {
        Logger.error('[CLOB] Failed to create client for ' + user.wallet.address.slice(0,6) + ': ' + err);
        return null;
    }
};

const createClobClient = async (customPk?: string, proxyAddress?: string, forcedSigType?: SignatureTypeV2, useBuilderCreds: boolean = false): Promise<ClobClient> => {
    const host = CLOB_HTTP_URL;
    const pk = (customPk || PRIVATE_KEY) as `0x${string}`;

    if (!pk) throw new Error('PRIVATE_KEY is required to create CLOB client');

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
            Logger.info(`[CLOB] Using Builder credentials for ${account.address.slice(0,6)}`);
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
    } catch (err: any) {
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
