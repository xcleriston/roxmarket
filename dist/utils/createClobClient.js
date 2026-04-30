import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env.js';
import Logger from './logger.js';
import fetchData from './fetchData.js';
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL || 'https://clob.polymarket.com/';
const clobClientCache = new Map();
export const findProxyWallet = async (eoaOrUser, retries = 3) => {
    const eoa = typeof eoaOrUser === 'string' ? eoaOrUser : eoaOrUser?.wallet?.address;
    if (!eoa)
        return null;
    // Use manual proxy if explicitly set in user object (and not just placeholder)
    if (typeof eoaOrUser === 'object' && eoaOrUser?.wallet?.proxyAddress && eoaOrUser?.wallet?.isProxyVerified) {
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
    // 1. Check if user has verified info in DB
    let proxyInfo = null;
    if (user.wallet.proxyAddress && user.wallet.signatureType && user.wallet.isProxyVerified) {
        proxyInfo = {
            address: user.wallet.proxyAddress,
            type: user.wallet.signatureType
        };
    }
    else {
        // 2. Detect via Gamma API
        proxyInfo = await findProxyWallet(user);
        // 3. Persist to DB if found or explicitly confirmed EOA
        try {
            const User = (await import('../models/user.js')).default;
            await User.updateOne({ _id: user._id }, {
                $set: {
                    'wallet.proxyAddress': proxyInfo?.address || null,
                    'wallet.signatureType': proxyInfo?.type || SignatureTypeV2.EOA,
                    'wallet.isProxyVerified': true
                }
            });
        }
        catch (err) {
            Logger.warning(`[PROXY] Could not persist proxy info for ${user._id}: ${err}`);
        }
    }
    try {
        const client = await createClobClient(user.wallet.privateKey, proxyInfo?.address, proxyInfo?.type);
        clobClientCache.set(cacheKey, client);
        return client;
    }
    catch (err) {
        Logger.error(`[CLOB] Failed to create client for ${user.wallet.address.slice(0, 6)}: ${err}`);
        return null;
    }
};
const createClobClient = async (customPk, proxyAddress, forcedSigType) => {
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
    Logger.info(`[CLOB] Initializing for ${account.address.slice(0, 6)} with SigType: ${signatureType} ${proxyAddress ? `(Proxy: ${proxyAddress.slice(0, 6)})` : '(EOA)'}`);
    let client = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: walletClient,
        signatureType,
    });
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    // We only silence if NOT in debug mode
    if (process.env.DEBUG !== 'true') {
        console.log = function () { };
        console.error = function () { };
    }
    try {
        const creds = await client.createOrDeriveApiKey();
        client = new ClobClient({
            host,
            chain: Chain.POLYGON,
            signer: walletClient,
            creds,
            signatureType,
        });
        return client;
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
    finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
};
export default createClobClient;
