const https = require('https');

const token = '8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4';
const chatId = '918021282';

function notifyTraderUpdate() {
    const message = `POLYCOPY BOT - TRADER ATUALIZADO

Novo trader configurado para cópia:
0x2005d16a84ceefa912d4e380cd32e7ff827875ea

Configurações atuais:
- Estratégia: 10% PERCENTAGE
- Modo: Preview (Seguro)
- Monitoramento: Ativo
- Notificações: Habilitadas

Bot está monitorando trades do novo trader.
Você receberá notificações quando ele fizer operações.

Web UI: http://localhost:3000
Status: Online e funcionando`;

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
            console.log('\n=== NOTIFICAÇÃO ENVIADA ===');
            const response = JSON.parse(data);
            console.log('Status:', response.ok ? 'SUCESSO' : 'ERRO');
            if (response.ok) {
                console.log('Mensagem ID:', response.result.message_id);
                console.log('========================\n');
                console.log('Trader atualizado com sucesso!');
                console.log('Bot agora está monitorando: 0x2005d16a84ceefa912d4e380cd32e7ff827875ea');
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

console.log('Enviando notificação de atualização de trader...');
notifyTraderUpdate();
