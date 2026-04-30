import getMyBalance from '../src/utils/getMyBalance.js';
import { ENV } from '../src/config/env.js';

async function verify() {
    console.log('--- USDC Balance Verification ---');
    console.log(`RPC_URL: ${ENV.RPC_URL}`);
    console.log(`Main USDC Contract (Active): ${ENV.USDC_CONTRACT_ADDRESS}`);
    
    // A known funded wallet or a dummy one
    const testAddress = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'; // Native USDC contract itself for test (might return 0 or large val)
    
    try {
        const balance = await getMyBalance(testAddress);
        console.log(`Balance for ${testAddress}: $${balance}`);
        console.log('SUCCESS: Balance check completed without errors.');
    } catch (err) {
        console.error('FAILURE: Balance check failed!', err);
    }
}

verify();
