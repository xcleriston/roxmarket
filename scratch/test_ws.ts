import WebSocket from 'ws';

const ws = new WebSocket('wss://ws-live-data.polymarket.com');

ws.on('open', () => {
    console.log('Connected to Polymarket Live Feed');
    ws.send(JSON.stringify({
        type: 'subscribe',
        topic: 'activity'
    }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'activity') {
        console.log('Activity detected:', msg.payload.side, msg.payload.usdcSize, 'by', msg.payload.proxyWallet);
    }
});

ws.on('error', (err) => console.error('WS Error:', err));
setTimeout(() => {
    console.log('Test finished');
    ws.close();
    process.exit(0);
}, 10000);
