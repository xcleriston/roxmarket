import mongoose from 'mongoose';
import { ENV } from '../src/config/env.js';
import { Activity } from '../src/models/userHistory.js';

async function clearTrades() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(ENV.MONGODB_URI);
        console.log('Connected.');

        console.log('Clearing UserActivity collection...');
        const result = await Activity.deleteMany({});
        console.log(`Deleted ${result.deletedCount} old records.`);

        await mongoose.connection.close();
        console.log('Database connection closed.');
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

clearTrades();
