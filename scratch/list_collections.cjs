const mongoose = require('mongoose');
const uri = "mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/test";

async function check() {
    await mongoose.connect(uri);
    console.log('Connected to DB');
    
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));
    
    await mongoose.disconnect();
}

check();
