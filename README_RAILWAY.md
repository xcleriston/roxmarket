# Deploy PolyCopy no Railway

## Overview

Railway é ideal para o PolyCopy pois suporta:
- Background jobs (bot Telegram)
- Persistência de dados
- Dashboard web
- Processos contínuos

## Arquivos de Configuração

### 1. railway.toml
Configuração principal do Railway:
- Build com NIXPACKS
- Dois serviços: web + telegram-bot
- Política de restart automático

### 2. docker-compose.yml
Define os serviços:
- **app**: Dashboard web + API
- **telegram-bot**: Bot Telegram independente
- Volume compartilhado para dados

### 3. Dockerfile
Container otimizado para Railway:
- Multi-stage build
- Health check integrado
- Volume para persistência

## Deploy no Railway

### 1. Preparar Repositório

```bash
# Adicionar arquivos ao Git
git add .
git commit -m "Configurar para deploy Railway"

# Push para GitHub
git push origin main
```

### 2. Configurar no Railway

1. Acesse [railway.app](https://railway.app)
2. Clique "New Project" → "Deploy from GitHub repo"
3. Selecione o repositório do PolyCopy
4. Railway detectará automaticamente os serviços

### 3. Environment Variables

Configure no Railway:

```bash
# Configurações do Bot
USER_ADDRESSES=0x2005d16a84ceefa912d4e380cd32e7ff827875ea
PROXY_WALLET=0x742d35cc6634c0532925a3b844bc9e7595f0beb0
PRIVATE_KEY=sua_private_key_aqui

# Estratégia de Trading
COPY_STRATEGY=PERCENTAGE
COPY_SIZE=10.0
MAX_ORDER_SIZE_USD=100.0
MIN_ORDER_SIZE_USD=1.0
SLIPPAGE_TOLERANCE=0.05
DAILY_LOSS_CAP_PCT=20
PREVIEW_MODE=true
TRADE_AGGREGATION_ENABLED=false

# Performance
FETCH_INTERVAL=10
RETRY_LIMIT=3
REQUEST_TIMEOUT_MS=10000
NETWORK_RETRY_LIMIT=3
TOO_OLD_TIMESTAMP=1

# APIs
CLOB_HTTP_URL=https://clob.polymarket.com/
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws
RPC_URL=https://poly.api.pocket.network
USDC_CONTRACT_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

# Telegram
TELEGRAM_BOT_TOKEN=8607996597:AAH6yTuUH3eQSW0I_KglSfsG2iYFPFHlPH4
TELEGRAM_CHAT_ID=918021282

# Sistema
NODE_ENV=production
PORT=3000
```

### 4. Deploy Automático

Railway irá:
- Buildar o projeto
- Criar dois containers
- Configurar health checks
- Expor portas automaticamente

## Serviços no Railway

### Web Service
- **URL**: `https://seu-app.railway.app`
- **Porta**: 3000
- **Função**: Dashboard + API endpoints

### Telegram Bot Service
- **Background**: Roda continuamente
- **Função**: Bot Telegram + copy trading
- **Logs**: Acessíveis no dashboard Railway

## Vantagens do Railway

✅ **Full Functionality**
- Bot Telegram 24/7
- Dashboard web completo
- Persistência de dados
- Trade monitoring em tempo real

✅ **Facilidade de Deploy**
- Auto-detect de serviços
- GitHub integration
- Zero config deployment

✅ **Monitoramento**
- Logs centralizados
- Métricas de performance
- Health checks

## URLs Após Deploy

- **Dashboard**: `https://seu-app.railway.app`
- **API Health**: `https://seu-app.railway.app/api/health`
- **Config API**: `https://seu-app.railway.app/api/config/advanced`
- **Trades**: `https://seu-app.railway.app/api/trades`

## Troubleshooting

### Bot não responde
1. Verifique TELEGRAM_BOT_TOKEN
2. Verifique TELEGRAM_CHAT_ID
3. Verifique logs no Railway

### Dashboard não carrega
1. Verifique se o serviço "app" está rodando
2. Verifique variáveis de ambiente
3. Verifique health checks

### Dados não persistem
1. Verifique volume `/app/data`
2. Verifique permissões do container
3. Verifique se os serviços compartilham dados

## Escalabilidade

Railway permite:
- **Vertical**: Mais CPU/RAM
- **Horizontal**: Múltiplas instâncias
- **Database**: PostgreSQL integrado
- **Storage**: Volumes persistentes

## Custos

- **Free tier**: $5/mês (suficiente para desenvolvimento)
- **Hobby**: $20/mês (produção leve)
- **Pro**: $50/mês (produção pesada)

Railway é a solução ideal para deploy completo do PolyCopy! 🚀
