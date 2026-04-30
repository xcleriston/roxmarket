import axios from 'axios';
import TelegramBotStandalone from './standalone';

class TelegramStandaloneServer {
    private bot: TelegramBotStandalone;
    private token: string;

    constructor(token: string) {
        this.token = token;
        this.bot = new TelegramBotStandalone(token);
    }

    async startPolling() {
        console.log('🤖 Iniciando bot Telegram standalone...');
        console.log(`📱 Bot: https://t.me/PolyCop_BOT`);
        console.log('⏳ Aguardando mensagens...');

        let lastUpdate = 0;

        while (true) {
            try {
                const response = await axios.get(
                    `https://api.telegram.org/bot${this.token}/getUpdates?offset=${lastUpdate + 1}&timeout=30`
                );

                const updates = response.data.result;
                
                for (const update of updates) {
                    lastUpdate = update.update_id;

                    if (update.message) {
                        await this.bot.handleMessage(update.message);
                    } else if (update.callback_query) {
                        await this.bot.handleCallback(
                            update.callback_query.data,
                            update.callback_query.message.chat.id.toString()
                        );

                        // Answer callback query
                        await axios.post(
                            `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
                            {
                                callback_query_id: update.callback_query.id,
                                text: 'Processando...'
                            }
                        );
                    }
                }

                // Wait before next request
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error('Erro no polling:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async getBotInfo() {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${this.token}/getMe`);
            return response.data.result;
        } catch (error) {
            console.error('Erro ao obter informações do bot:', error);
            return null;
        }
    }
}

export default TelegramStandaloneServer;
