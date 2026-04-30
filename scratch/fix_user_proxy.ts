import mongoose from 'mongoose';
import User from '../src/models/user.js';
import { ENV } from '../src/config/env.js';

async function fixUser() {
    const eoa = '0x31DC678E3610B6E81C109eFe410fC26434b0748f';
    const proxy = '0x338d21D48A6e2C38A0Cb3C5304188DB67f40eeDF';
    
    console.log(`Fixing user EOA: ${eoa} -> Proxy: ${proxy}`);
    
    // Fallback URI if ENV is missing it
    const uri = ENV.MONGODB_URI || 'mongodb://127.0.0.1:27017/polycopy';
    
    try {
        await mongoose.connect(uri);
        const result = await User.updateOne(
            { 'wallet.address': { $regex: new RegExp(`^${eoa}$`, 'i') } },
            { $set: { 'wallet.proxyAddress': proxy } }
        );
        
        if (result.matchedCount > 0) {
            console.log('✅ User updated successfully!');
        } else {
            console.log('❌ User not found in database.');
        }
        
        await mongoose.disconnect();
    } catch (err) {
        console.error('Error fixing user:', err);
    }
}

fixUser();
