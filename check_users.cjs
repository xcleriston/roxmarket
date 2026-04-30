const mongoose = require('mongoose');

async function diagnose() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polycopy');
    const users = await mongoose.connection.collection('users').find({}).toArray();
    
    console.log(`Total Users: ${users.length}`);
    users.forEach(u => {
        console.log(`User: ${u.username}`);
        console.log(`  Trader: [${u.config?.traderAddress}]`);
        console.log(`  Enabled: ${u.config?.enabled}`);
        console.log(`  Mode: ${u.config?.mode}`);
    });
    
    process.exit(0);
}

diagnose();
