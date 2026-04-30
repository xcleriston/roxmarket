import TelegramStandaloneServer from './standalone-server';
const TELEGRAM_BOT_TOKEN = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN não encontrado');
    process.exit(1);
}
async function startTelegramBot() {
    const telegramServer = new TelegramStandaloneServer(TELEGRAM_BOT_TOKEN);
    // Get bot info
    const botInfo = await telegramServer.getBotInfo();
    if (botInfo) {
        console.log(`🤖 Bot Telegram: @${botInfo.username}`);
        console.log(`📱 Nome: ${botInfo.first_name}`);
        console.log(`🔗 Link: https://t.me/${botInfo.username}`);
    }
    // Start polling
    await telegramServer.startPolling();
}
startTelegramBot().catch(console.error);
