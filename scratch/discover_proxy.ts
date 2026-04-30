import fetchData from '../src/utils/fetchData.js';

async function discoverProxy(address) {
    const endpoints = [
        `https://data-api.polymarket.com/activity?user=${address}`,
        `https://data-api.polymarket.com/positions?user=${address}`,
        `https://data-api.polymarket.com/profiles/${address}`
    ];

    console.log(`Searching for Proxy for EOA: ${address}`);
    
    for (const url of endpoints) {
        try {
            console.log(`Trying ${url}...`);
            const res = await fetchData(url);
            
            // Handle activity/positions (array)
            if (Array.isArray(res) && res.length > 0) {
                const proxy = res[0].proxyWallet;
                if (proxy) {
                    console.log(`FOUND via Activity/Positions: ${proxy}`);
                    return proxy;
                }
            }
            
            // Handle profiles (object or array)
            if (res && res.proxyWallet) {
                console.log(`FOUND via Profile: ${res.proxyWallet}`);
                return res.proxyWallet;
            }
            
            if (Array.isArray(res) && res.length > 0 && res[0].proxyWallet) {
                console.log(`FOUND via Profile (Array): ${res[0].proxyWallet}`);
                return res[0].proxyWallet;
            }

        } catch (e) {
            console.error(`Error with ${url}:`, e.message);
        }
    }

    console.log('No proxy found via any API endpoint.');
    return null;
}

discoverProxy('0x31DC678E3610B6E81C109eFe410fC26434b0748f');
