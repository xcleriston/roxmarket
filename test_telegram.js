const https = require('https');
const token = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';

function testTelegramConnection(chatId) {
    const message = `*POLYCOPY BOT INICIADO* 

\`\`\`
Status: Online
Modo: Preview (Seguro)
Trader: 0xd625...e809
Estratégia: 10% PERCENTAGE
\`\`\`

Bot está monitorando trades. 
Envie /status para verificar status atual.

*Para operar real:*
1. Configure carteira real
2. Desative PREVIEW_MODE
3. Adicione fundos USDC`;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    const postData = JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log('\n=== MENSAGEM ENVIADA COM SUCESSO ===');
            console.log('Resposta:', data);
            console.log('=================================\n');
        });
    });

    req.on('error', (error) => {
        console.error('Erro ao enviar mensagem:', error);
    });

    req.write(postData);
    req.end();
}

// Para teste manual, descomente e insira seu chat ID
// testTelegramConnection('SEU_CHAT_ID_AQUI');

console.log('Script de teste Telegram criado!');
console.log('Para usar:');
console.log('1. Envie "oi" para @Copies_polybot no Telegram');
console.log('2. Execute: node get_telegram_chat.js');
console.log('3. Copie o Chat ID retornado');
console.log('4. Edite este script e insira o Chat ID');
console.log('5. Execute: node test_telegram.js');
