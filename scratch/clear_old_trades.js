import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGODB_URI = 'mongodb+srv://polycopy:polycopy2026@cluster0.7lvjncx.mongodb.net/';

async function clearTrades() {
    try {
        if (!MONGODB_URI) {
            throw new Error('MONGODB_URI not found in environment');
        }
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        
        console.log('Clearing UserActivity collection...');
        // We can use the collection name directly if we don't want to import the model
        const collection = mongoose.connection.collection('useractivities');
        const result = await collection.deleteMany({});
        console.log(`Deleted ${result.deletedCount} old records.`);

        await mongoose.connection.close();
        console.log('Database connection closed.');
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

clearTrades();
