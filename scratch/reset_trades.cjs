const mongoose = require('mongoose');
const uri = "mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/test";

const UserActivitySchema = new mongoose.Schema({
    bot: Boolean,
    timestamp: Date
}, { strict: false });

const Activity = mongoose.model('UserActivity', UserActivitySchema);

async function reset() {
    await mongoose.connect(uri);
    console.log('Connected to DB');
    
    // Reset all trades from today to bot: false
    const today = new Date('2026-04-25');
    const result = await Activity.updateMany({ 
        timestamp: { $gte: today },
        type: 'TRADE' 
    }, { 
        $set: { bot: false, processedBy: [] } 
    });
    
    console.log(`Reset ${result.modifiedCount} trades for re-processing.`);
    
    await mongoose.disconnect();
}

reset();
