import axios from 'axios';
import TelegramBot from './bot.js';
import Logger from '../utils/logger.js';
class TelegramServer {
    bot;
    token;
    webhookUrl;
    constructor(token, webhookUrl) {
        this.token = token;
        this.webhookUrl = webhookUrl;
        this.bot = new TelegramBot(token);
    }
    async startPolling() {
        Logger.info('🤖 Iniciando bot Telegram (polling)...');
        try {
            const botInfo = await this.getBotInfo();
            if (botInfo) {
                Logger.success(`📱 Bot Telegram online: @${botInfo.username}`);
            }
        }
        catch (e) { }
        Logger.info('⏳ Aguardando mensagens...');
        let lastUpdate = 0;
        while (true) {
            try {
                const response = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates?offset=${lastUpdate + 1}&timeout=30`);
                const updates = response.data.result;
                for (const update of updates) {
                    lastUpdate = update.update_id;
                    if (update.message) {
                        await this.bot.handleMessage(update.message);
                    }
                    else if (update.callback_query) {
                        await this.bot.handleCallback(update.callback_query.data, update.callback_query.message.chat.id.toString());
                        // Answer callback query
                        await axios.post(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
                            callback_query_id: update.callback_query.id,
                            text: 'Processando...'
                        });
                    }
                }
                // Wait before next request
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            catch (error) {
                Logger.error(`Erro no polling do Telegram: ${error.message || error}`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
    async setWebhook() {
        if (!this.webhookUrl) {
            console.log('⚠️ Webhook URL não configurada, usando polling...');
            return;
        }
        try {
            await axios.post(`https://api.telegram.org/bot${this.token}/setWebhook`, {
                url: this.webhookUrl
            });
            console.log(`✅ Webhook configurado: ${this.webhookUrl}`);
        }
        catch (error) {
            console.error('Erro ao configurar webhook:', error);
        }
    }
    async getBotInfo() {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${this.token}/getMe`);
            return response.data.result;
        }
        catch (error) {
            console.error('Erro ao obter informações do bot:', error);
            return null;
        }
    }
}
export default TelegramServer;
