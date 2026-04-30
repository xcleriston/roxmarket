import fetchData from '../src/utils/fetchData.js';

async function testApi(address) {
    console.log(`Testing API for ${address}...`);
    try {
        const activityUrl = `https://data-api.polymarket.com/activity?user=${address}`;
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
        
        console.log('Fetching Activity...');
        const activity = await fetchData(activityUrl);
        console.log(`Activity items found: ${activity.length}`);
        if (activity.length > 0) {
            console.log(`First activity proxyWallet: ${activity[0].proxyWallet}`);
        }
        
        console.log('Fetching Positions...');
        const positions = await fetchData(positionsUrl);
        console.log(`Positions items found: ${positions.length}`);
        if (positions.length > 0) {
            console.log(`First position proxyWallet: ${positions[0].proxyWallet}`);
        }
    } catch (err) {
        console.error('API Test failed!', err);
    }
}

testApi('0x31DC678E3610B6E81C109eFe410fC26434b0748f');
