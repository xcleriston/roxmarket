const https = require('https');

const token = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';
const chatId = '918021282';

function sendSimpleMessage() {
    const message = `POLYCOPY BOT - TESTE DE NOTIFICAÇÃO

Status: Online
Modo: Preview (Seguro)
Trader: 0xd62531bc536bff72394fc5ef715525575787e809
Estratégia: 10% PERCENTAGE

Bot está monitorando trades. Você receberá notificações quando o trader fizer uma operação.

Web UI: http://localhost:3000
API Docs: http://localhost:3000/docs`;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    const postData = JSON.stringify({
        chat_id: chatId,
        text: message
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
            const response = JSON.parse(data);
            console.log('Status:', response.ok ? 'SUCESSO' : 'ERRO');
            if (response.ok) {
                console.log('Mensagem ID:', response.result.message_id);
                console.log('=================================\n');
                console.log('VERIFIQUE SEU TELEGRAM!');
                console.log('Você deve ter recebido uma mensagem do @Copies_polybot');
            } else {
                console.log('Erro:', response.description);
            }
        });
    });

    req.on('error', (error) => {
        console.error('Erro ao enviar mensagem:', error);
    });

    req.write(postData);
    req.end();
}

console.log('Enviando mensagem de teste simples para o Telegram...');
sendSimpleMessage();
