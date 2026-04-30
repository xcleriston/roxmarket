const https = require('https');

const token = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';
const chatId = '918021282';

function sendTestMessage() {
    const message = `*POLYCOPY BOT - TESTE DE NOTIFICAÇÃO* 

\`\`\`
Status: Online
Modo: Preview (Seguro)
Trader: 0xd625...e809
Estratégia: 10% PERCENTAGE
Chat ID: ${chatId}
\`\`\`

Bot está monitorando trades. 
Você receberá notificações quando o trader fizer uma operação.

*Comandos disponíveis:*
/status - Verificar status atual
/help - Ajuda do bot

*Para operar em modo real:*
1. Configure carteira real
2. Desative PREVIEW_MODE
3. Adicione fundos USDC

*Web UI:* http://localhost:3000`;

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
            console.log('Resposta:', JSON.parse(data));
            console.log('=================================\n');
            console.log('Verifique seu Telegram! Você deve ter recebido uma mensagem do @Copies_polybot');
        });
    });

    req.on('error', (error) => {
        console.error('Erro ao enviar mensagem:', error);
    });

    req.write(postData);
    req.end();
}

console.log('Enviando mensagem de teste para o Telegram...');
sendTestMessage();
