const mongoose = require('mongoose');
const uri = "mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/test";

const UserActivitySchema = new mongoose.Schema({
    traderAddress: String,
    bot: Boolean,
    processedBy: [String],
    transactionHash: String,
    timestamp: Date
}, { strict: false });

const Activity = mongoose.model('UserActivity', UserActivitySchema);

async function check() {
    await mongoose.connect(uri);
    console.log('Connected to DB');
    
    // Check trades from today 25/04
    const today = new Date('2026-04-25');
    const trades = await Activity.find({ 
        timestamp: { $gte: today },
        type: 'TRADE' 
    }).sort({ timestamp: -1 }).lean();
    
    console.log(`Trades from today: ${trades.length}`);
    trades.forEach(t => {
        console.log(`- Hash: ${t.transactionHash}`);
        console.log(`  Bot: ${t.bot}`);
        console.log(`  ProcessedBy: ${JSON.stringify(t.processedBy)}`);
        console.log(`  FollowerStatuses: ${JSON.stringify(t.followerStatuses)}`);
    });
    
    await mongoose.disconnect();
}

check();
