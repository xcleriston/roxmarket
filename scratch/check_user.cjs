const mongoose = require('mongoose');
const uri = "mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/test";

const UserSchema = new mongoose.Schema({
    username: String,
    config: {
        enabled: Boolean,
        traderAddress: String,
        mode: String
    }
}, { strict: false });

const User = mongoose.model('User', UserSchema);

async function check() {
    await mongoose.connect(uri);
    console.log('Connected to DB');
    
    const u = await User.findOne({ username: 'copiador' }).lean();
    console.log('User copiador:', JSON.stringify(u, null, 2));
    
    const traderAddress = u?.config?.traderAddress;
    if (traderAddress) {
        const followers = await User.find({ 
            'config.traderAddress': { $regex: new RegExp(`^${traderAddress}$`, 'i') },
            'config.enabled': true,
            'config.mode': { $in: ['COPY', 'MIRROR_100'] }
        }).lean();
        console.log(`Followers for ${traderAddress}: ${followers.length}`);
        followers.forEach(f => console.log(`- ${f.username} (${f.config.mode})`));
    }
    
    await mongoose.disconnect();
}

check();
