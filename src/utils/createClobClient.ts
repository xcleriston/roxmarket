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
            return undiciFetch(url, { ...options, dispatcher: socksAgent } as any);
        };
    } catch (e) {
        console.warn('[NETWORK] USE_PROXY=true mas pacotes de proxy não encontrados. Usando fetch padrão.');
    }
}

export interface ProxyInfo {
    address: string;
    type: SignatureTypeV2;
}

export const findProxyWallet = async (eoaOrUser: string | any, retries = 3): Promise<ProxyInfo | null> => {
    const eoa = typeof eoaOrUser === 'string' ? eoaOrUser : eoaOrUser?.wallet?.address;
    if (!eoa) return null;

    // BUG FIX: Prioridade de endereços:
    // 1. fundsWallet (Gnosis Safe) — onde o USDC está, informado manualmente pelo usuário
    // 2. proxyAddress salvo no banco (pode ser o API proxy errado — verificar)
    // 3. Auto-detect via gamma-api (retorna API proxy, não o Gnosis Safe)
    if (typeof eoaOrUser === 'object') {
        // Gnosis Safe informado manualmente — usa sempre
        if (eoaOrUser?.wallet?.fundsWallet) {
            Logger.info(`[PROXY] Using fundsWallet (Gnosis Safe): ${eoaOrUser.wallet.fundsWallet.slice(0, 10)}...`);
            return {
                address: eoaOrUser.wallet.fundsWallet,
                type: SignatureTypeV2.POLY_GNOSIS_SAFE
            };
        }
        // proxyAddress verificado e salvo (apenas se isProxyVerified=true indica que é o Gnosis Safe)
        if (eoaOrUser?.wallet?.proxyAddress && eoaOrUser?.wallet?.isProxyVerified) {
            return { 
                address: eoaOrUser.wallet.proxyAddress, 
                type: (eoaOrUser.wallet.signatureType as SignatureTypeV2) || SignatureTypeV2.POLY_GNOSIS_SAFE
            };
        }
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

// Cache em memória (sobrevive ao ciclo da requisição, não ao restart)
const clobClientCache: Map<string, ClobClient> = new Map();
// Controle de tentativas para não spammar o Cloudflare
const clobFailureCount: Map<string, number> = new Map();
const CLOB_CREDS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Permite limpar o cache de um usuário específico (ex: após 403 Cloudflare)
export const clearClobCache = (address: string) => {
    clobClientCache.delete(address.toLowerCase());
    clobFailureCount.delete(address.toLowerCase());
    Logger.info(`[CLOB] Cache cleared for ${address.slice(0,8)}`);
};

export const getClobClientForUser = async (user: any): Promise<ClobClient | null> => {
    if (!user.wallet?.privateKey) return null;

    const cacheKey = user.wallet.address.toLowerCase();

    // 1. Cache em memória — mais rápido, evita qualquer chamada à rede
    if (clobClientCache.has(cacheKey)) return clobClientCache.get(cacheKey)!;

    // 2. Verificar se falhou muitas vezes recentemente (evitar spam ao Cloudflare)
    const failures = clobFailureCount.get(cacheKey) || 0;
    if (failures >= 3) {
        // Depois de 3 falhas, aguardar 10min antes de tentar novamente
        Logger.warning(`[CLOB] Skipping ${cacheKey.slice(0,8)} — too many recent failures (${failures}). Will retry later.`);
        return null;
    }

    const proxyInfo = user.wallet.proxyAddress && user.wallet.signatureType && user.wallet.isProxyVerified
        ? { address: user.wallet.proxyAddress, type: user.wallet.signatureType as SignatureTypeV2 }
        : await findProxyWallet(user);

    try {
        const account = privateKeyToAccount(
            (user.wallet.privateKey.startsWith('0x') ? user.wallet.privateKey : `0x${user.wallet.privateKey}`) as `0x${string}`
        );
        const walletClient = createWalletClient({ account, chain: polygon, transport: http(ENV.RPC_URL) });
        const signatureType = proxyInfo?.type ?? SignatureTypeV2.EOA;
        const host = CLOB_HTTP_URL;

        // 3. BUG FIX: Usar credenciais salvas no banco se ainda válidas (< 7 dias)
        //    Isso evita chamar /auth/api-key repetidamente, que causa bloqueio Cloudflare
        const savedCreds = user.wallet?.clobCreds;
        const credsAge = savedCreds?.derivedAt ? Date.now() - savedCreds.derivedAt : Infinity;

        if (savedCreds?.key && savedCreds?.secret && savedCreds?.passphrase && credsAge < CLOB_CREDS_TTL_MS) {
            Logger.debug(`[CLOB] Using saved credentials for ${account.address.slice(0,8)} (age: ${Math.round(credsAge/3600000)}h)`);
            const client = new ClobClient({
                host, chain: Chain.POLYGON, signer: walletClient,
                creds: { key: savedCreds.key, secret: savedCreds.secret, passphrase: savedCreds.passphrase },
                signatureType,
            });
            clobClientCache.set(cacheKey, client);
            clobFailureCount.delete(cacheKey);
            return client;
        }

        // 4. Credenciais ausentes ou expiradas — derivar uma vez e salvar no banco
        Logger.info(`[CLOB] Deriving new API key for ${account.address.slice(0,8)}... (this calls /auth/api-key once)`);
        const baseClient = new ClobClient({ host, chain: Chain.POLYGON, signer: walletClient, signatureType });
        const creds = await baseClient.createOrDeriveApiKey();

        // Salvar credenciais no banco para evitar novas chamadas
        const User = (await import('../models/user.js')).default;
        await User.updateOne(
            { _id: user._id },
            { $set: { 'wallet.clobCreds': { ...creds, derivedAt: Date.now() } } }
        );
        Logger.success(`[CLOB] Credentials saved to DB for ${account.address.slice(0,8)}`);

        const client = new ClobClient({
            host, chain: Chain.POLYGON, signer: walletClient,
            creds, signatureType,
        });
        clobClientCache.set(cacheKey, client);
        clobFailureCount.delete(cacheKey);
        return client;

    } catch (err: any) {
        const count = (clobFailureCount.get(cacheKey) || 0) + 1;
        clobFailureCount.set(cacheKey, count);
        Logger.error(`[CLOB] Failed to create client for ${cacheKey.slice(0,8)} (attempt ${count}): ${err?.message || err}`);

        // Se for 403 Cloudflare, limpar creds salvas para forçar nova derivação depois
        if (err?.message?.includes('403') || err?.status === 403) {
            Logger.warning(`[CLOB] 403 Cloudflare detected for ${cacheKey.slice(0,8)} — clearing saved creds`);
            const User = (await import('../models/user.js')).default;
            await User.updateOne({ _id: user._id }, { $unset: { 'wallet.clobCreds': 1 } });
        }
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
