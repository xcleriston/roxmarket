# 🐛 Guia de Debug — Trades Não Detectadas ou Não Copiadas

## Checklist de Diagnóstico

### 1. Trades Não São Detectadas Pelo Monitor

**O que procurar nos logs do Railway:**

```
[MONITOR] Active Traders: 0x...
[MONITOR-0x...] Fetched N activities from API
[MONITOR-0x...] Latest activity age: Xs, cutoff: Xs
⚡ [FAST-DETECT] New trade for 0x...
```

**Se ver 0 atividades:**
- O endereço do trader está certo? (Verifique em Configurações → `traderAddress`)
- O trader fez trades recentes no Polymarket? (Cheque https://polymarket.com)
- A API está respondendo? (Rode manualmente: `curl "https://data-api.polymarket.com/trades?userAddress=0x...&limit=5"`)

**Se as atividades forem muito antigas (cutoff excedido):**
- O Polymarket está retornando trades de horas atrás
- `TOO_OLD_TIMESTAMP` pode estar muito curto — padrão é 24h

---

### 2. Monitor Detecta Mas Executor Não Copia

**O que procurar:**

```
⚡ [FAST-DETECT] New trade for 0x...
[EXECUTOR] Found N followers for trader 0x...
```

**Se `Found 0 followers`:**

a) **Nenhum usuário está configurado para copiar esse trader:**
   - Verifique se tem usuários com esse `traderAddress` setado
   - Rode: `db.users.find({ 'config.traderAddress': '0x...' })`

b) **A query do executor não está encontrando:**
   - Verifique a CASE — é case-sensitive!
   - `traderAddress` no DB é lowercase, sua query precisa de `.toLowerCase()`
   - Rode no MongoDB: `db.users.findOne({ 'config.traderAddress': '0x...' })` (minúsculo!)

c) **O usuário não está no banco:**
   - Verifique em Painel Admin → Usuários
   - Se não aparecer, ele nunca se configurou

---

### 3. Executor Encontra Followers Mas Não Executa Trades

**O que procurar:**

```
[EXECUTOR] Found 1 followers for trader 0x...
👤 FOLLOWER: <userId> copying 0x...
```

**Depois procure por:**

```
✅ [SUCCESS] Trade executed
⚠️ [SKIP] Trade skipped
❌ [ERROR] Failed to post order
```

**Se ver SKIP:**
- Pode ser `SALDO INSUFICIENTE` — user não tem USDC
- `EXPOSIÇÃO MÁXIMA ATINGIDA` — já tem muitas posições abertas
- `TAMANHO MUITO PEQUENO` — trade é < $0.10

**Se ver ERROR:**
- `Failed to create order` — problema com a chave privada ou proxy
- `401 Unauthorized` — credenciais CLOB inválidas
- Cheque `/api/user/me` para ver se auth está funcionando

---

### 4. Trades São Copiadas Mas Não Aparecem em "Atividades Recentes"

**O que procurar:**

- Rides de `POST` com status 200 em `/api/user/trades`
- Verifique no MongoDB se `processedBy` está sendo populado:
  ```
  db.activities.findOne({ _id: ObjectId('...') }).processedBy
  ```
  Deve ser um array com o userId: `["6..."]`

**Se não aparecer:**
- Trade foi salva com `processedBy: []` vazio
- Executor nunca marcou como `$addToSet`
- Verifique logs do executor por `[EXECUTOR]` e `👤 FOLLOWER`

---

## 📊 Queries MongoDB úteis

```javascript
// Contar traders configurados
db.users.countDocuments({ 'config.traderAddress': { $exists: true, $ne: '' } })

// Ver todos os traders únicos
db.users.distinct('config.traderAddress')

// Ver todas as atividades de um trader
db.activities.find({ traderAddress: '0x...' }).limit(5)

// Ver trades que foram copiados (processedBy não vazio)
db.activities.find({ processedBy: { $ne: [] } }).limit(5)

// Ver trades antigos não processados
db.activities.find({ bot: false, timestamp: { $lt: Date.now() - 3600000 } }).count()
```

---

## 🔧 Fixes Rápidos

### Fix 1: Trader Encontrado Mas Não Seguidores
```javascript
// Verifique se o endereço está exato (case-sensitive!)
db.users.findOne({ 'config.traderAddress': '0x...' })
// Se não encontrar, tente uppercase:
db.users.findOne({ 'config.traderAddress': '0X...' })
```

### Fix 2: Limpar Cache de Trades Antigos
```javascript
// O monitor tem cache local que não é limpo entre deploys
// Se as trades antigas ainda estão sendo processadas, restart no Railway
// Ou espere 1 hora para o cache se limpar automaticamente
```

### Fix 3: Reprocessar Trade Manualmente
```javascript
// Se uma trade foi detectada mas não copiada, marque como bot:false
db.activities.updateOne(
  { transactionHash: '0x...' },
  { $set: { bot: false, processedBy: [] } }
)
// Executor vai tentar de novo no próximo ciclo (~100ms)
```

---

## 🚀 Modo Debug Ativado

Para mais logs detalhados, adicione ao `.env`:

```
LOG_LEVEL=debug
MONITOR_VERBOSE=true
```

Isso vai printar cada atividade fetched e cada follower processado.

---

## 📞 Exemplo Completo de Fluxo

```
1. User A configura traderAddress = 0x123...abc (minúsculo)
2. Monitor busca https://data-api.polymarket.com/trades?userAddress=0x123...abc
3. API retorna: { timestamp: 1234567890, side: 'BUY', size: '100', ...}
4. Monitor salva em DB: { traderAddress: '0x123...abc', bot: false, processedBy: [] }
5. Monitor chama processDetectedTrade()
6. Executor faz: User.find({ 'config.traderAddress': '0x123...abc' })
7. Executor encontra [User A] e inicia copy
8. Executor faz: Activity.updateOne({ $addToSet: { processedBy: userAId } })
9. Resultado: { ..., processedBy: [userAId], bot: false }
10. Frontend chama /api/user/trades, recebe a atividade com executionStatus='SUCESSO'
11. Mostra na tabela de "Atividades Recentes"
```

Se quebrar em qualquer step, o fluxo para aí.
