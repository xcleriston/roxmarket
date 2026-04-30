import axios from 'axios';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const isEnabled = () => !!TELEGRAM_BOT_TOKEN;
const send = async (chatId, message) => {
    if (!isEnabled() || !chatId)
        return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: message, parse_mode: 'Markdown' }, { timeout: 5000 });
    }
    catch {
        // Silently fail to avoid disrupting trading
    }
};
const telegram = {
    isEnabled,
    send,
    tradeExecuted: (chatId, side, amount, price, market) => send(chatId, `✅ *${side}* $${amount.toFixed(2)} @ $${price.toFixed(4)}\n📊 ${market}`),
    killSwitch: (chatId, lossPct) => send(chatId, `🛑 *KILL SWITCH TRIGGERED*\nDaily loss: ${lossPct.toFixed(1)}%\nTrading halted.`),
    error: (chatId, msg) => send(chatId, `❌ *Error*: ${msg}`),
    startup: (chatId, traderCount, balance) => send(chatId, `🚀 *Bot Started*\nTracking ${traderCount} trader(s)\nBalance: $${balance.toFixed(2)}`),
    tpSlTriggered: (chatId, message) => send(chatId, `🛡️ *RISK MANAGEMENT*\n${message}`),
};
export default telegram;
