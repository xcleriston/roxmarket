import webpush from 'web-push';
import { ENV } from '../config/env.js';
import User from '../models/user.js';
import Logger from './logger.js';

// VAPID keys should be generated once and stored in .env
// Use: npx web-push generate-vapid-keys
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@polyhacker.tech';

if (PUBLIC_KEY && PRIVATE_KEY) {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

export const sendPushNotification = async (userId: string, payload: any) => {
    try {
        const user = await User.findById(userId);
        if (!user || !user.pushSubscription) return;

        const subscription = JSON.parse(user.pushSubscription);
        
        await webpush.sendNotification(
            subscription,
            JSON.stringify(payload)
        );
        
        Logger.info(`[Push] Notification sent to user \${user.username || userId}`);
    } catch (error) {
        Logger.error(`[Push] Failed to send notification: \${error}`);
        // If 410 (Gone), the subscription is no longer valid
        if ((error as any).statusCode === 410) {
            await User.updateOne({ _id: userId }, { $unset: { pushSubscription: 1 } });
        }
    }
};

export const broadcastTrade = async (traderAddress: string, tradeData: any) => {
    const followers = await User.find({ 
        'config.traderAddress': traderAddress, 
        pushSubscription: { $exists: true } 
    });

    for (const follower of followers) {
        await sendPushNotification((follower._id as any).toString(), {
            title: 'Poly Hacker Alert ⚡',
            body: `Trade detected: \${tradeData.side} \${tradeData.usdcSize} USDC on \${tradeData.slug}`,
            icon: '/icon.png',
            data: { url: '/' }
        });
    }
};
