const https = require('https');
const token = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';

function getChatId() {
    const url = `https://api.telegram.org/bot${token}/getUpdates`;
    
    https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            try {
                const updates = JSON.parse(data);
                if (updates.result && updates.result.length > 0) {
                    const chatId = updates.result[updates.result.length - 1].message.from.id;
                    console.log(`\n=== CHAT ID ENCONTRADO ===`);
                    console.log(`Chat ID: ${chatId}`);
                    console.log(`\nUse este valor no campo TELEGRAM_CHAT_ID do .env`);
                    console.log(`========================\n`);
                } else {
                    console.log('\n=== NENHUMA MENSAGEM ENCONTRADA ===');
                    console.log('1. Abra o Telegram');
                    console.log('2. Busque por @Copies_polybot');
                    console.log('3. Envie qualquer mensagem (ex: "oi")');
                    console.log('4. Execute este script novamente');
                    console.log('================================\n');
                }
            } catch (error) {
                console.error('Erro ao processar resposta:', error);
            }
        });
    }).on('error', (error) => {
        console.error('Erro na requisição:', error);
    });
}

getChatId();
