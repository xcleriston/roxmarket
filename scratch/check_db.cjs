const mongoose = require('mongoose');

const UserActivitySchema = new mongoose.Schema({
    traderAddress: String,
    bot: Boolean,
    type: String,
    transactionHash: String
}, { strict: false });

const Activity = mongoose.model('UserActivity', UserActivitySchema);

async function check() {
    const uri = "mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/test"; // Added /test as default db if unknown
    
    await mongoose.connect(uri);
    console.log('Connected to DB');
    
    const count = await Activity.countDocuments({ bot: false });
    console.log(`Unprocessed trades (bot: false): ${count}`);
    
    const trades = await Activity.find({ bot: false }).limit(10);
    trades.forEach(t => {
        console.log(`- Hash: ${t.transactionHash}, Type: "${t.type}", Trader: ${t.traderAddress}`);
    });
    
    await mongoose.disconnect();
}

check();
