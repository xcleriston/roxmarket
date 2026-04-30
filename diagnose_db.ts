import mongoose from 'mongoose';
import { Activity } from './src/models/userHistory.js';
import { ENV } from './src/config/env.js';

async function diagnose() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polycopy');
    const trader = '0xb54101496b7078873447869c1804b2f85a3d1852';
    const count = await Activity.countDocuments({ traderAddress: trader });
    const latest = await Activity.findOne({ traderAddress: trader }).sort({ timestamp: -1 });
    
    console.log(`Trader: ${trader}`);
    console.log(`Activity Count: ${count}`);
    if (latest) {
        console.log(`Latest DB Trade Timestamp: ${latest.timestamp}`);
    }
    
    process.exit(0);
}

diagnose();
