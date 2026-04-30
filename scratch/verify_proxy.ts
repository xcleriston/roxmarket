import { findPolymarketProxy } from '../src/server/setup.js';
import getMyBalance from '../src/utils/getMyBalance.js';

async function verifyProxyLogic() {
    console.log('--- Proxy Wallet Support Verification ---');
    
    // A known Polymarket EOA that has a proxy
    const testEoa = '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b';
    
    try {
        console.log(`Step 1: Detecting proxy for EOA ${testEoa}...`);
        const proxy = await findPolymarketProxy(testEoa);
        console.log(`Result: ${proxy ? proxy : 'No proxy found'}`);
        
        if (proxy) {
            console.log(`Step 2: Checking balance for Proxy ${proxy}...`);
            const balance = await getMyBalance(testEoa, proxy);
            console.log(`Balance: $${balance}`);
        }
        
        console.log('SUCCESS: Proxy logic verification completed.');
    } catch (err) {
        console.error('FAILURE: Verification failed!', err);
    }
}

verifyProxyLogic();
