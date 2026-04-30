import mongoose from 'mongoose';
import User from '../models/user.js';
import { ENV } from '../config/env.js';

/**
 * Migration script to fix existing users with proxy wallets
 * Sets isProxyVerified and signatureType for users who have proxyAddress
 */
async function migrateProxyWallets() {
    try {
        await mongoose.connect(ENV.MONGODB_URI || '');
        console.log('[MIGRATION] Connected to MongoDB');

        // Find all users with proxyAddress but missing isProxyVerified
        const usersToMigrate = await User.find({
            'wallet.proxyAddress': { $exists: true, $ne: null, $ne: '' },
            $or: [
                { 'wallet.isProxyVerified': { $exists: false } },
                { 'wallet.isProxyVerified': false }
            ]
        });

        console.log(`[MIGRATION] Found ${usersToMigrate.length} users to migrate`);

        for (const user of usersToMigrate) {
            console.log(`[MIGRATION] Migrating user ${user.username || user.chatId || user._id}`);
            
            user.wallet.isProxyVerified = true;
            user.wallet.signatureType = user.wallet.signatureType || 'POLY_GNOSIS_SAFE';
            
            await user.save();
            console.log(`[MIGRATION] ✓ Migrated: ${user.wallet.address} -> Proxy: ${user.wallet.proxyAddress}`);
        }

        console.log('[MIGRATION] ✅ Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('[MIGRATION] ❌ Error:', error);
        process.exit(1);
    }
}

migrateProxyWallets();
