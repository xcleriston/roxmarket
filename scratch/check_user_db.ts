import mongoose from 'mongoose';
import User from '../src/models/user.js';
import { ENV } from '../src/config/env.js';

async function checkUser(address) {
    console.log(`Checking user with EOA address: ${address}`);
    try {
        await mongoose.connect(ENV.MONGODB_URI);
        const user = await User.findOne({ 'wallet.address': { $regex: new RegExp(`^${address}$`, 'i') } });
        if (user) {
            console.log('User found:');
            console.log(JSON.stringify(user.wallet, null, 2));
        } else {
            console.log('User NOT found in database.');
        }
        await mongoose.disconnect();
    } catch (err) {
        console.error('Error querying database:', err);
    }
}

checkUser('0x31DC678E3610B6E81C109eFe410fC26434b0748f');
