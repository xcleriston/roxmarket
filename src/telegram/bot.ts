import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import User, { IUser } from '../models/user.js';
import fetchData from '../utils/fetchData.js';

interface User {
    chatId: string;
    wallet?: {
        address: string;
        privateKey: string;
    };
    config?: {
        traderAddress?: string;
        strategy?: string;
        copySize?: number;
    };
    step?: 'start' | 'wallet' | 'trader' | 'strategy' | 'deposit' | 'ready' | 'connect_wallet';
    refCode?: string;
}

class TelegramBot {
    private token: string;


    constructor(token: string) {
        this.token = token;
        this.migrateLegacyUsers().catch(err => console.error('Migration error:', err));
    }


    private async migrateLegacyUsers() {
        try {
            const usersPath = path.join(process.cwd(), 'data', 'telegram_users.json');
            if (fs.existsSync(usersPath)) {
                const data = fs.readFileSync(usersPath, 'utf-8');
                const legacyUsers = JSON.parse(data);
                for (const legacyUser of legacyUsers) {
                    const exists = await User.findOne({ chatId: legacyUser.chatId });
                    if (!exists) {
                        await User.create(legacyUser);
                        console.log(`Migrated user ${legacyUser.chatId} to MongoDB`);
                    }
                }
                // Backup and remove the legacy file after migration? 
                // Maybe just leave it for now to be safe, or rename it.
                fs.renameSync(usersPath, usersPath + '.bak');
            }
        } catch (error) {
            console.error('Error migrating users:', error);
        }
    }


    private generateWallet() {
        const wallet = ethers.Wallet.createRandom();
        return {
            address: wallet.address,
            privateKey: wallet.privateKey
        };
    }

    private generateRefCode(): string {
        return 'ref_' + Math.random().toString(36).substr(2, 9).toUpperCase();
    }

    private getDepositLinks(address: string) {
        return {
            usdc: `https://wallet.polygon.technology/polygon/bridge/deposit?to=${address}`,
            pol: `https://www.coingecko.com/en/coins/polygon?utm_source=polycopy`,
            quickswap: `https://quickswap.exchange/#/swap?inputCurrency=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174&outputCurrency=0x458Efe634a885F2A2A57B106063e822A060f9dcF&recipient=${address}`
        };
    }

    private async sendMessage(chatId: string, text: string, keyboard?: any) {
        const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
        
        const payload: any = {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        };

        if (keyboard) {
            payload.reply_markup = {
                inline_keyboard: keyboard
            };
        }

        try {
            await axios.post(url, payload);
        } catch (error) {
            console.error('Error sending message:', error);
        }
    }

    private async handleStart(chatId: string, refCode?: string) {
        let user = await User.findOne({ chatId });
        
        if (!user) {
            user = await User.create({
                chatId,
                step: 'start',
                refCode: refCode
            });
        }

        const welcomeMessage = `*🚀 BEM-VINDO AO POLYCOPY BOT!*

Este bot irá criar sua carteira e configurar seu sistema de copy trading automático.

*📋 PASSO 1: CRIAR CARTEIRA*

Vou gerar uma carteira Polygon para você começar a operar na Polymarket.

⚠️ *MUITO IMPORTANTE:* 
• Guarde sua chave privada em local seguro
• Nunca compartilhe com ninguém
• A chave dá acesso total aos seus fundos

Clique em "Gerar Carteira" para continuar:`;

        const keyboard = [
            [{ text: '🔐 Gerar Nova Carteira', callback_data: 'generate_wallet' }],
            [{ text: '🔗 Conectar conta existente', callback_data: 'connect_account' }],
            [{ text: '❓ Como Funciona?', callback_data: 'how_it_works' }]
        ];

        await this.sendMessage(chatId, welcomeMessage, keyboard);
    }

    private async handleConnectAccount(chatId: string) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        await User.updateOne({ chatId }, { $set: { step: 'connect_wallet' } });

        const connectMessage = `*🔗 CONECTAR CONTA EXISTENTE*

Por favor, envie sua **Chave Privada** (Private Key) da Polygon/Ethereum.

⚠️ *SEGURANÇA:*
• Use uma chave que você já possua na Polymarket
• O bot usará esta chave apenas para assinar ordens localmente
• Nunca compartilhe esta chave com terceiros

*Digite sua chave privada de 64 caracteres:*`;

        await this.sendMessage(chatId, connectMessage);
    }

    private async handleGenerateWallet(chatId: string) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        const wallet = this.generateWallet();
        await User.updateOne({ chatId }, { $set: { wallet, step: 'wallet' } });

        const depositLinks = this.getDepositLinks(wallet.address);

        const walletMessage = `*✅ CARTEIRA CRIADA COM SUCESSO!*

*📍 ENDEREÇO DA CARTEIRA:*
\`${wallet.address}\`

*🔑 CHAVE PRIVADA:*
\`${wallet.privateKey}\`

⚠️ *SALVE ESTA CHAVE PRIVADA EM LOCAL SEGURO!*
• Anote em papel
• Salve em gerenciador de senhas
• Nunca compartilhe

*💰 PASSO 2: DEPOSITAR FUNDOS*

Para operar, você precisa de:
• **USDC** para fazer trades
• **POL** para taxas de gás

*🔗 LINKS DE DEPÓSITO:*

1. **Bridge USDC → Polygon:**
${depositLinks.usdc}

2. **Comprar POL (gás):**
${depositLinks.pol}

3. **QuickSwap (alternativa):**
${depositLinks.quickswap}

*💡 VALOR SUGERIDO:* Comece com $100-500 USDC

Após depositar, clique em "Confirmar Depósito":`;

        const keyboard = [
            [{ text: '✅ Já Depositei Fundos', callback_data: 'deposit_confirmed' }],
            [{ text: '❓ Ajuda com Depósito', callback_data: 'deposit_help' }]
        ];

        await this.sendMessage(chatId, walletMessage, keyboard);
    }

    private async handleDepositConfirmed(chatId: string) {
        const user = await User.findOne({ chatId });
        if (!user || !user.wallet) return;

        await User.updateOne({ chatId }, { $set: { step: 'trader' } });

        const traderMessage = `*📊 PASSO 3: ESCOLHER TRADER*

Agora escolha qual trader você deseja copiar:

*🎯 OPÇÕES POPULARES:*

1. *Trader Exemplo 1* (Alto volume)
   \`0x2005d16a84ceefa912d4e380cd32e7ff827875ea\`

2. *Trader Exemplo 2* (Conservador)
   \`0xd62531bc536bff72394fc5ef715525575787e809\`

3. *Custom* (Seu próprio trader)

Digite o endereço do trader que deseja copiar ou escolha uma opção acima:`;

        const keyboard = [
            [{ text: '🎯 Usar Trader Popular 1', callback_data: 'trader_popular_1' }],
            [{ text: '🛡️ Usar Trader Popular 2', callback_data: 'trader_popular_2' }],
            [{ text: '📝 Inserir Endereço Customizado', callback_data: 'trader_custom' }]
        ];

        await this.sendMessage(chatId, traderMessage, keyboard);
    }

    private async handleTraderSelection(chatId: string, traderAddress: string) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        await User.updateOne({ chatId }, { 
            $set: { 
                'config.traderAddress': traderAddress.toLowerCase(), 
                step: 'strategy' 
            } 
        });

        const strategyMessage = `*⚙️ PASSO 4: CONFIGURAR ESTRATÉGIA*

Escolha sua estratégia de copy trading:

*📈 ESTRATÉGIAS DISPONÍVEIS:*

1. *Porcentagem* (Recomendado)
   Copia X% de cada trade
   Ex: 10% = se trader investir $100, você investe $10

2. *Valor Fixo*
   Valor fixo por trade
   Ex: $50 por trade independente do tamanho

3. *Adaptiva*
   Ajusta % baseado no tamanho do trade
   Menor % para trades grandes, maior % para pequenos

Escolha sua estratégia:`;

        const keyboard = [
            [{ text: '📊 Porcentagem (10%)', callback_data: 'strategy_percentage' }],
            [{ text: '💰 Valor Fixo ($50)', callback_data: 'strategy_fixed' }],
            [{ text: '🔄 Adaptiva', callback_data: 'strategy_adaptive' }]
        ];

        await this.sendMessage(chatId, strategyMessage, keyboard);
    }

    private async handleStrategySelection(chatId: string, strategy: string, copySize: number) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        await User.updateOne({ chatId }, { 
            $set: { 
                'config.strategy': strategy, 
                'config.copySize': copySize, 
                step: 'ready' 
            } 
        });
        
        const updatedUser = await User.findOne({ chatId });
        if (!updatedUser) return;

        const readyMessage = `*🎉 CONFIGURAÇÃO CONCLUÍDA!*

*📋 RESUMO DA SUA CONFIGURAÇÃO:*

📍 *Carteira:* \`${updatedUser.wallet!.address}\`
🎯 *Trader:* \`${updatedUser.config!.traderAddress}\`
⚙️ *Estratégia:* ${updatedUser.config!.strategy}
💰 *Copy Size:* ${updatedUser.config!.copySize}%

*🚀 PRÓXIMOS PASSOS:*

1. ✅ Bot está configurado
2. ✅ Monitorando trades do trader
3. ⏳ Aguardando novas operações

*📱 COMANDOS DISPONÍVEIS:*
/status - Ver status atual
/wallet - Ver informações da carteira
/config - Ver configurações
/help - Ajuda

*🌐 ACESSAR DASHBOARD:*
http://localhost:3000

*⚠️ MODO SEGURO ATIVO:*
Por enquanto, o bot está operando em modo preview (sem trades reais). 
Para ativar trades reais, desative o PREVIEW_MODE nas configurações.

Parabéns! Seu bot está pronto para operar! 🚀`;

        const keyboard = [
            [{ text: '📊 Ver Status', callback_data: 'check_status' }],
            [{ text: '🌐 Abrir Dashboard', url: 'http://localhost:3000' }],
            [{ text: '❓ Ajuda', callback_data: 'help' }]
        ];

        await this.sendMessage(chatId, readyMessage, keyboard);
    }

    public async handleCallback(callbackData: string, chatId: string) {
        switch (callbackData) {
            case 'generate_wallet':
                await this.handleGenerateWallet(chatId);
                break;
            case 'connect_account':
                await this.handleConnectAccount(chatId);
                break;
            case 'deposit_confirmed':
                await this.handleDepositConfirmed(chatId);
                break;
            case 'trader_popular_1':
                await this.handleTraderSelection(chatId, '0x2005d16a84ceefa912d4e380cd32e7ff827875ea');
                break;
            case 'trader_popular_2':
                await this.handleTraderSelection(chatId, '0xd62531bc536bff72394fc5ef715525575787e809');
                break;
            case 'trader_custom':
                await this.sendMessage(chatId, '*⌨️ INSERIR TRADER CUSTOMIZADO*\n\nPor favor, envie o endereço da carteira do trader que deseja copiar (ex: `0x...`):');
                break;
            case 'strategy_percentage':
                await this.handleStrategySelection(chatId, 'PERCENTAGE', 10.0);
                break;
            case 'strategy_fixed':
                await this.handleStrategySelection(chatId, 'FIXED', 50.0);
                break;
            case 'strategy_adaptive':
                await this.handleStrategySelection(chatId, 'ADAPTIVE', 10.0);
                break;
            case 'check_status':
                await this.sendStatus(chatId);
                break;
            case 'help':
                await this.sendHelp(chatId);
                break;
            default:
                await this.sendMessage(chatId, 'Opção não reconhecida. Tente novamente.');
        }
    }

    private async sendStatus(chatId: string) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        const statusMessage = `*📊 STATUS DO SEU BOT*

📍 *Carteira:* ${user.wallet?.address || 'Não configurada'}
🛰️ *Modo:* ${user.config?.mode || 'COPY'}
🎯 *Trader:* ${user.config?.traderAddress || 'Não configurado'}
⚙️ *Estratégia:* ${user.config?.strategy || 'Não configurada'}
📝 *Step:* ${user.step || 'Não iniciado'}

*🌐 Dashboard:* http://localhost:3000
*📖 API Docs:* http://localhost:3000/docs`;

        await this.sendMessage(chatId, statusMessage);
    }

    private async sendHelp(chatId: string) {
        const helpMessage = `*❓ AJUDA - POLYCOPY BOT*

*🚀 COMANDOS:*
/start - Iniciar configuração
/status - Ver status atual
/positions - Ver posições abertas
/wallet - Informações da carteira
/config - Ver configurações
/help - Esta mensagem de ajuda

*🔗 LINKS ÚTEIS:*
Dashboard: http://localhost:3000
API Docs: http://localhost:3000/docs

*📞 SUPORTE:*
Se precisar de ajuda, contate nosso suporte.

*⚠️ IMPORTANTE:*
• Nunca compartilhe sua chave privada
• Mantenha seu bot atualizado
• Monitore suas operações regularmente`;

        await this.sendMessage(chatId, helpMessage);
    }

    public async handleMessage(message: any) {
        const chatId = message.chat.id.toString();
        const text = message.text;
        const user = await User.findOne({ chatId });

        if (text?.startsWith('/start')) {
            const refCode = text.split(' ')[1];
            await this.handleStart(chatId, refCode);
        } else if (text?.startsWith('/status')) {
            await this.sendStatus(chatId);
        } else if (text?.startsWith('/help')) {
            await this.sendHelp(chatId);
        } else if (text?.startsWith('/wallet')) {
            await this.sendStatus(chatId);
        } else if (text?.startsWith('/positions')) {
            await this.handlePositions(chatId);
        } else if (text?.startsWith('/config')) {
            await this.sendStatus(chatId);
        } else if (user?.step === 'connect_wallet' && text) {
            await this.processPrivateKey(chatId, text);
        } else if (user?.step === 'trader' && text) {
            await this.processTraderAddress(chatId, text);
        }
    }

    private async handlePositions(chatId: string) {
        const user = await User.findOne({ chatId });
        if (!user || !user.wallet || !user.wallet.address) {
            await this.sendMessage(chatId, '❌ Você ainda não configurou uma carteira. Use /start');
            return;
        }

        await this.sendMessage(chatId, '⏳ Buscando suas posições em tempo real...');

        try {
            const positionsData = await fetchData(`https://data-api.polymarket.com/positions?user=${user.wallet.address}`);
            if (!Array.isArray(positionsData)) {
                await this.sendMessage(chatId, '❌ Erro ao buscar dados da Polymarket.');
                return;
            }

            const activePositions = positionsData.filter(p => p.size > 0 && p.currentValue > 0);
            
            if (activePositions.length === 0) {
                await this.sendMessage(chatId, '📭 *Você não tem nenhuma posição aberta no momento.*');
                return;
            }

            let msg = `📌 *SUAS POSIÇÕES ABERTAS*\n\n`;
            let totalExposure = 0;
            let totalPnl = 0;

            activePositions.sort((a, b) => b.currentValue - a.currentValue).forEach(pos => {
                const entryPrice = pos.avgPrice || 0;
                const curPrice = pos.currentValue / pos.size;
                let pnlPercent = 0;
                let pnlUSD = 0;
                
                if (entryPrice > 0) {
                    pnlPercent = ((curPrice - entryPrice) / entryPrice) * 100;
                    pnlUSD = pos.currentValue - (pos.size * entryPrice);
                }

                totalExposure += pos.currentValue;
                totalPnl += pnlUSD;

                const pnlIcon = pnlUSD >= 0 ? '🟢' : '🔴';
                msg += `*${(pos.title || 'Mercado').slice(0, 35)}...*\n`;
                msg += `↳ ${pos.outcome || 'Token'} | ${pos.size.toFixed(1)} tokens\n`;
                msg += `↳ Entrada: ${(entryPrice * 100).toFixed(1)}¢ | Atual: ${(curPrice * 100).toFixed(1)}¢\n`;
                msg += `↳ Valor: $${pos.currentValue.toFixed(2)} | P&L: ${pnlIcon} ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(1)}%\n\n`;
            });

            msg += `━━━━━━━━━━━━━━\n`;
            msg += `💰 *Exposição Total:* $${totalExposure.toFixed(2)}\n`;
            msg += `📈 *P&L Aberto:* ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;

            await this.sendMessage(chatId, msg);
        } catch (error) {
            console.error('Error fetching positions for telegram /positions:', error);
            await this.sendMessage(chatId, '❌ Ocorreu um erro ao buscar suas posições.');
        }
    }

    private async processPrivateKey(chatId: string, privateKey: string) {
        const user = await User.findOne({ chatId });
        if (!user) return;

        // Clean price key (remove 0x header if present)
        const cleanKey = privateKey.trim().replace(/^0x/, '');

        // Basic validation: 64 hex characters
        if (!/^[0-9a-fA-F]{64}$/.test(cleanKey)) {
            await this.sendMessage(
                chatId,
                '❌ *Chave Privada Inválida.*\n\nA chave deve ter exatamente 64 caracteres hexadecimais. Tente novamente:'
            );
            return;
        }

        try {
            const walletDerived = new ethers.Wallet(cleanKey);
            await User.updateOne({ chatId }, { 
                $set: { 
                    'wallet.address': walletDerived.address,
                    'wallet.privateKey': cleanKey
                } 
            });
            
            await this.sendMessage(
                chatId,
                `✅ *Conta Conectada com Sucesso!*\n\n📍 *Endereço:* \`${walletDerived.address}\`\n\nAgora vamos configurar quem você deseja copiar.`
            );

            // Directly jump to trader selection
            await this.handleDepositConfirmed(chatId);

        } catch (error) {
            await this.sendMessage(
                chatId,
                '❌ *Erro ao importar chave.* Verifique se a chave é válida e tente novamente.'
            );
        }
    }

    private async processTraderAddress(chatId: string, address: string) {
        const cleanAddress = address.trim();
        if (!ethers.utils.isAddress(cleanAddress)) {
            await this.sendMessage(chatId, '❌ *Endereço Inválido.*\n\nPor favor, envie um endereço de carteira válido (0x...):');
            return;
        }

        await this.handleTraderSelection(chatId, cleanAddress);
    }
}

export default TelegramBot;
