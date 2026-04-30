import TelegramServer from './server';
import { ENV } from '../config/env';
const TELEGRAM_BOT_TOKEN = ENV.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN não encontrado no .env');
    process.exit(1);
}
async function startTelegramBot() {
    const telegramServer = new TelegramServer(TELEGRAM_BOT_TOKEN);
    // Get bot info
    const botInfo = await telegramServer.getBotInfo();
    if (botInfo) {
        console.log(`🤖 Bot Telegram: @${botInfo.username}`);
        console.log(`📱 Nome: ${botInfo.first_name}`);
        console.log(`🔗 Link: https://t.me/${botInfo.username}`);
    }
    // Start polling (simpler than webhook for local testing)
    await telegramServer.startPolling();
}
startTelegramBot().catch(console.error);
