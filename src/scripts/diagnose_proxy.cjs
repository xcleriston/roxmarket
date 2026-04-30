
const { ethers } = require('ethers');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Load .env
dotenv.config({ path: path.join(__dirname, '../.env') });

async function diagnose() {
    console.log('\n🔍 POLYCOPY DIAGNOSTIC TOOL\n');
    
    const pk = process.env.PRIVATE_KEY;
    const envProxy = process.env.PROXY_WALLET;
    
    if (!pk) {
        console.log('❌ ERROR: No PRIVATE_KEY found in .env');
        return;
    }
    
    const wallet = new ethers.Wallet(pk);
    const eoa = wallet.address.toLowerCase();
    
    console.log('--- Configuration ---');
    console.log('Signer (EOA):', eoa);
    console.log('Env Proxy:   ', envProxy || 'Not set');
    
    console.log('\n--- Gamma API Check ---');
    try {
        const url = 'https://gamma-api.polymarket.com/public-profile?address=' + eoa;
        const resp = await axios.get(url);
        const gammaProxy = resp.data.proxyWallet?.toLowerCase();
        
        console.log('Gamma Proxy: ', gammaProxy || 'None (Standard Wallet)');
        
        if (gammaProxy && envProxy && gammaProxy !== envProxy.toLowerCase()) {
            console.log('\n⚠️  MISMATCH DETECTED!');
            console.log('Your .env has a different proxy than Polymarket recognizes for this key.');
            console.log('This will cause "invalid signature" errors during trading.');
        } else if (!gammaProxy && envProxy) {
             console.log('\n⚠️  MISMATCH DETECTED!');
             console.log('You configured a proxy in .env, but Polymarket sees this as a standard EOA.');
        } else {
            console.log('\n✅ Proxy configuration looks consistent with Polymarket.');
        }
    } catch (e) {
        console.log('❌ Gamma API Error:', e.message);
        console.log('Check your internet connection or if the Gamma API is down.');
    }
    
    console.log('\n----------------------');
}

diagnose();
