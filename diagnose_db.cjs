const mongoose = require('mongoose');

async function diagnose() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polycopy');
    const trader = '0xb54101496b7078873447869c1804b2f85a3d1852';
    
    // In Mongoose, models are registered globally. 
    // Since I'm not importing the schema, I'll use the raw collection.
    const collection = mongoose.connection.collection('useractivities');
    const count = await collection.countDocuments({ traderAddress: trader });
    const latest = await collection.find({ traderAddress: trader }).sort({ timestamp: -1 }).limit(1).toArray();
    
    console.log(`Trader: ${trader}`);
    console.log(`Activity Count: ${count}`);
    if (latest.length > 0) {
        console.log(`Latest DB Trade Timestamp: ${latest[0].timestamp}`);
        console.log(`Latest DB Trade Hash: ${latest[0].transactionHash}`);
    }
    
    process.exit(0);
}

diagnose();
