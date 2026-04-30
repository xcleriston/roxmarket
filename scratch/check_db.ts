import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UserActivitySchema = new mongoose.Schema({
    traderAddress: String,
    bot: Boolean,
    type: String,
    transactionHash: String
}, { strict: false });

const Activity = mongoose.model('UserActivity', UserActivitySchema);

async function check() {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.log('Connected to DB');
    
    const count = await Activity.countDocuments({ bot: false });
    console.log(`Unprocessed trades (bot: false): ${count}`);
    
    const trades = await Activity.find({ bot: false }).limit(5);
    trades.forEach(t => {
        console.log(`- Hash: ${t.transactionHash}, Type: ${t.type}, Trader: ${t.traderAddress}`);
    });
    
    await mongoose.disconnect();
}

check();
