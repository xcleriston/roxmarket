import express from 'express';
import { ethers } from 'ethers';
import swaggerUi from 'swagger-ui-express';
import { setupNewUser } from './setup.js';
import cookieParser from 'cookie-parser';
import { authenticateToken, authorizeAdmin, login, signup } from './auth.js';
import bcrypt from 'bcryptjs';
import Logger from '../utils/logger.js';
import User from '../models/user.js';
import getMyBalance from '../utils/getMyBalance.js';
import fetchData from '../utils/fetchData.js';
import { getClobClientForUser, findProxyWallet } from '../utils/createClobClient.js';
const app = express();
app.use(express.json());
app.use(cookieParser());
// --- Security Headers (Fix for Production Outage) ---
app.use((req, res, next) => {
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data: https:; connect-src 'self' https:;");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
});
let botStartTime = Date.now();
// --- Swagger API Docs ---
const swaggerDoc = {
    openapi: '3.0.0',
    info: { title: 'PolyCopy API', version: '2.0.0', description: 'Monitor and manage your copy trading bot' },
    paths: {
        '/api/health': { get: { summary: 'Health check', tags: ['System'], responses: { 200: { description: 'OK' } } } },
        '/api/status': { get: { summary: 'Bot status', tags: ['Bot'], responses: { 200: { description: 'Bot running status' } } } },
        '/api/config': { get: { summary: 'Current configuration', tags: ['Config'], responses: { 200: { description: 'Config values' } } } },
        '/api/trades': { get: { summary: 'Recent trades', tags: ['Trading'], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }], responses: { 200: { description: 'Trade list' } } } },
    },
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));
// --- Admin Bootstrap ---
const bootstrapAdmin = async () => {
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'hacker123';
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@polyhacker.com';
    try {
        let user = await User.findOne({
            $or: [{ username: adminUser }, { email: adminEmail }]
        });
        const hashedPassword = await bcrypt.hash(adminPass, 10);
        if (!user) {
            console.log(`🚀 [BOOTSTRAP] Criando Administrador: ${adminUser}`);
            user = new User({
                username: adminUser,
                email: adminEmail,
                password: hashedPassword,
                role: 'admin',
                step: 'ready'
            });
            await user.save();
        }
        else {
            console.log(`⚡ [BOOTSTRAP] Validando permissões de administrador: ${adminUser}`);
            user.role = 'admin';
            user.password = hashedPassword; // Forçar sincronia com env
            await user.save();
        }
    }
    catch (error) {
        console.error('❌ [BOOTSTRAP] Erro crítico:', error);
    }
};
// --- API Auth (Public) ---
app.post('/api/auth/login', login);
app.post('/api/auth/signup', signup);
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        v: '2.5.0-RBAC-FIX-V3',
        ts: new Date().toISOString()
    });
});
// --- Protect all other /api routes ---
app.use('/api', authenticateToken);
// Middleware to populate fullUser for API routes
app.use('/api', async (req, res, next) => {
    if (req.user?.id) {
        try {
            req.fullUser = await User.findById(req.user.id);
        }
        catch (error) {
            console.error('Error fetching fullUser:', error);
        }
    }
    next();
});
app.get('/api/status', async (req, res) => {
    try {
        const mongoose = (await import('mongoose')).default;
        const totalUsers = await User.countDocuments();
        const activeUsers = await User.countDocuments({ 'config.enabled': true });
        res.json({
            running: true,
            dbConnected: mongoose.connection.readyState === 1,
            uptime: Math.floor((Date.now() - botStartTime) / 1000),
            username: req.user?.username || 'ANONYMOUS',
            role: req.user?.role || 'GUEST',
            totalUsers,
            activeUsers,
            previewMode: process.env.PREVIEW_MODE === 'true'
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch metrics' });
    }
});
app.get('/api/config', authorizeAdmin, async (_req, res) => {
    // Return summary of first few users for dashboard overview
    const users = await User.find().limit(5).lean();
    const config = {
        global: {
            previewMode: process.env.PREVIEW_MODE === 'true',
            fetchInterval: process.env.FETCH_INTERVAL || '10',
            maxOrderSize: process.env.MAX_ORDER_SIZE_USD || '100.0'
        },
        users: users.map(u => ({
            chatId: u.chatId,
            address: u.wallet?.address,
            trader: u.config?.traderAddress,
            strategy: u.config?.strategy,
            size: u.config?.copySize,
            enabled: u.config?.enabled,
            step: u.step
        }))
    };
    res.json(config);
});
app.get('/api/trades', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const { Activity } = await import('../models/userHistory.js');
        const dbTrades = await Activity.find()
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();
        const trades = dbTrades.map(trade => ({
            ...trade,
            isCopied: trade.bot === true || (trade.processedBy && trade.processedBy.length > 0)
        }));
        res.json(trades);
    }
    catch (error) {
        console.error('Error fetching trades:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/users', authorizeAdmin, async (_req, res) => {
    try {
        const users = await User.find().lean();
        res.json(users);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});
app.get('/api/users/:id', authorizeAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const user = id.length === 24
            ? await User.findById(id).lean()
            : await User.findOne({ chatId: id }).lean();
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        res.json(user);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});
app.post('/api/users/:id/config', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const { config, step, username, email, password } = req.body;
        const update = {};
        if (config)
            update.config = config;
        if (step)
            update.step = step;
        if (username !== undefined)
            update.username = username;
        if (email !== undefined)
            update.email = email;
        if (password && password.trim() !== '') {
            update.password = await bcrypt.hash(password, 10);
        }
        const user = id.length === 24
            ? await User.findByIdAndUpdate(id, update, { new: true })
            : await User.findOneAndUpdate({ chatId: id }, update, { new: true });
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});
app.post('/api/users/:id/reset', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const update = {
            $set: {
                step: 'welcome',
                wallet: undefined,
                'config.traderAddress': '',
                'config.enabled': false
            }
        };
        const user = id.length === 24
            ? await User.findByIdAndUpdate(id, update, { new: true })
            : await User.findOneAndUpdate({ chatId: id }, update, { new: true });
        res.json({ success: true, message: 'User reset successfully', user });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to reset user' });
    }
});
app.delete('/api/users/:id', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        if (id.length === 24) {
            await User.findByIdAndDelete(id);
        }
        else {
            await User.deleteOne({ chatId: id });
        }
        res.json({ success: true, message: 'User deleted successfully' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const { subscription } = req.body;
        await User.updateOne({ _id: req.user?.id }, { $set: { pushSubscription: JSON.stringify(subscription) } });
        res.json({ success: true, message: 'Push subscription saved' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to save subscription' });
    }
});
// --- Setup Endpoints (Legacy/Single) ---
app.post('/api/setup', async (req, res) => {
    try {
        const result = await setupNewUser(req.body);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Setup failed'
        });
    }
});
app.get('/api/setup/wallet', async (req, res) => {
    try {
        const { ethers } = await import('ethers');
        const wallet = ethers.Wallet.createRandom();
        res.json({
            address: wallet.address,
            privateKey: wallet.privateKey
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to create wallet'
        });
    }
});
// --- Advanced Configuration ---
app.get('/api/config/advanced', (_req, res) => {
    const advancedConfig = {
        copyStrategy: process.env.COPY_STRATEGY || 'PERCENTAGE',
        copySize: process.env.COPY_SIZE || '10.0',
        maxOrderSize: process.env.MAX_ORDER_SIZE_USD || '100.0',
        minOrderSize: process.env.MIN_ORDER_SIZE_USD || '1.0',
        fetchInterval: process.env.FETCH_INTERVAL || '10',
        slippageTolerance: process.env.SLIPPAGE_TOLERANCE || '0.05',
        dailyLossCap: process.env.DAILY_LOSS_CAP_PCT || '20',
        previewMode: process.env.PREVIEW_MODE || 'false',
        tradeAggregation: process.env.TRADE_AGGREGATION_ENABLED || 'false',
        retryLimit: process.env.RETRY_LIMIT || '3',
        requestTimeout: process.env.REQUEST_TIMEOUT_MS || '10000',
        networkRetryLimit: process.env.NETWORK_RETRY_LIMIT || '3',
        tooOldTimestamp: process.env.TOO_OLD_TIMESTAMP || '1',
        clobHttpUrl: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com/',
        clobWsUrl: process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws',
        rpcUrl: process.env.RPC_URL || 'https://poly.api.pocket.network',
        usdcContract: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
    };
    res.json(advancedConfig);
});
app.post('/api/config/advanced', async (req, res) => {
    try {
        const config = req.body;
        // Validate and update environment variables
        const updates = {
            'COPY_STRATEGY': config.copyStrategy,
            'COPY_SIZE': config.copySize,
            'MAX_ORDER_SIZE_USD': config.maxOrderSize,
            'MIN_ORDER_SIZE_USD': config.minOrderSize,
            'FETCH_INTERVAL': config.fetchInterval,
            'SLIPPAGE_TOLERANCE': config.slippageTolerance,
            'DAILY_LOSS_CAP_PCT': config.dailyLossCap,
            'PREVIEW_MODE': config.previewMode,
            'TRADE_AGGREGATION_ENABLED': config.tradeAggregation,
            'RETRY_LIMIT': config.retryLimit,
            'REQUEST_TIMEOUT_MS': config.requestTimeout,
            'NETWORK_RETRY_LIMIT': config.networkRetryLimit,
            'TOO_OLD_TIMESTAMP': config.tooOldTimestamp,
            'CLOB_HTTP_URL': config.clobHttpUrl,
            'CLOB_WS_URL': config.clobWsUrl,
            'RPC_URL': config.rpcUrl,
            'USDC_CONTRACT_ADDRESS': config.usdcContract
        };
        // Update .env file
        const fs = await import('fs');
        const path = await import('path');
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        }
        // Update or add each configuration
        Object.entries(updates).forEach(([key, value]) => {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}='${value}'`);
            }
            else {
                envContent += `\n${key}='${value}'`;
            }
        });
        fs.writeFileSync(envPath, envContent);
        res.json({
            success: true,
            message: 'Configuration updated successfully',
            config: updates
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update configuration'
        });
    }
});
app.post('/api/config/reset', async (_req, res) => {
    try {
        const defaults = {
            'COPY_STRATEGY': 'PERCENTAGE',
            'COPY_SIZE': '10.0',
            'MAX_ORDER_SIZE_USD': '100.0',
            'MIN_ORDER_SIZE_USD': '1.0',
            'FETCH_INTERVAL': '10',
            'SLIPPAGE_TOLERANCE': '0.05',
            'DAILY_LOSS_CAP_PCT': '20',
            'PREVIEW_MODE': 'true',
            'TRADE_AGGREGATION_ENABLED': 'false',
            'RETRY_LIMIT': '3',
            'REQUEST_TIMEOUT_MS': '10000',
            'NETWORK_RETRY_LIMIT': '3',
            'TOO_OLD_TIMESTAMP': '1',
            'CLOB_HTTP_URL': 'https://clob.polymarket.com/',
            'CLOB_WS_URL': 'wss://ws-subscriptions-clob.polymarket.com/ws',
            'RPC_URL': 'https://poly.api.pocket.network',
            'USDC_CONTRACT_ADDRESS': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
        };
        const fs = await import('fs');
        const path = await import('path');
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        }
        // Reset all to defaults
        Object.entries(defaults).forEach(([key, value]) => {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}='${value}'`);
            }
            else {
                envContent += `\n${key}='${value}'`;
            }
        });
        fs.writeFileSync(envPath, envContent);
        res.json({
            success: true,
            message: 'Configuration reset to defaults',
            config: defaults
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to reset configuration'
        });
    }
});
app.get('/setup', (_req, res) => {
    const setupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyCopy - Novo Usuário</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:20px}
.container{max-width:800px;margin:0 auto}
h1{color:var(--accent);margin-bottom:20px;font-size:1.5em;text-align:center}
.step{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px}
.step h3{color:var(--accent);margin-bottom:12px}
.form-group{margin-bottom:16px}
label{display:block;margin-bottom:4px;color:#8b949e;font-size:0.9em}
input,select{width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text)}
button{background:var(--accent);color:#fff;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-weight:600}
button:hover{background:#4a8eff}
button:disabled{background:#484f58;cursor:not-allowed}
.result{background:#0f4d2f;border:1px solid #2d5a3d;border-radius:4px;padding:12px;margin-top:12px}
.error{background:#4b111a;border:1px solid #6d1f27;border-radius:4px;padding:12px;margin-top:12px}
.wallet-info{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:12px;margin:12px 0;font-family:monospace;font-size:0.9em}
.links{margin-top:12px}
.links a{display:block;color:var(--accent);text-decoration:none;margin:4px 0}
.links a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
<h1>Polymarket Copy Trading Bot</h1>
<div class="step">
<h3>1. Configurar Trading</h3>
<div class="form-group">
<label>Trader para copiar:</label>
<input type="text" id="traderAddress" placeholder="0x..." value="0x2005d16a84ceefa912d4e380cd32e7ff827875ea">
</div>
<div class="form-group">
<label>Estratégia:</label>
<select id="strategy">
<option value="PERCENTAGE">Porcentagem (10%)</option>
<option value="FIXED">Valor Fixo ($50)</option>
<option value="ADAPTIVE">Adaptiva</option>
</select>
</div>
<div class="form-group">
<label>Valor inicial:</label>
<input type="number" id="initialAmount" placeholder="1000" value="1000">
</div>
</div>

<div class="step">
<h3>2. Gerar Carteira</h3>
<button onclick="generateWallet()">Gerar Nova Carteira</button>
<div id="walletResult"></div>
</div>

<div class="step">
<h3>3. Configurar Telegram (Opcional)</h3>
<div class="form-group">
<label>Token do Bot Telegram:</label>
<input type="text" id="telegramToken" placeholder="123456:ABC-DEF1234...">
</div>
</div>

<div class="step">
<h3>4. Finalizar Setup</h3>
<button onclick="completeSetup()" id="setupBtn">Configurar Bot</button>
<div id="setupResult"></div>
</div>
</div>

<script>
let walletData = null;

async function generateWallet() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    
    try {
        const response = await fetch('/api/setup/wallet');
        const data = await response.json();
        
        if (data.address) {
            walletData = data;
            document.getElementById('walletResult').innerHTML = 
                '<div class="wallet-info">' +
                '<strong>Endereço:</strong> ' + data.address + '<br>' +
                '<strong>Chave Privada:</strong> ' + data.privateKey + '<br><br>' +
                '<span style="color: var(--red);">SALVE ESTA CHAVE PRIVADA EM LOCAL SEGURO!</span>' +
                '</div>';
        } else {
            document.getElementById('walletResult').innerHTML = 
                '<div class="error">Erro ao gerar carteira</div>';
        }
    } catch (error) {
        document.getElementById('walletResult').innerHTML = 
            '<div class="error">Erro: ' + error.message + '</div>';
    }
    
    btn.disabled = false;
    btn.textContent = 'Gerar Nova Carteira';
}

async function completeSetup() {
    if (!walletData) {
        alert('Por favor, gere uma carteira primeiro');
        return;
    }
    
    const btn = document.getElementById('setupBtn');
    btn.disabled = true;
    btn.textContent = 'Configurando...';
    
    const setupData = {
        traderAddress: document.getElementById('traderAddress').value,
        strategy: document.getElementById('strategy').value,
        copySize: 10.0,
        telegramToken: document.getElementById('telegramToken').value
    };
    
    try {
        const response = await fetch('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(setupData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            document.getElementById('setupResult').innerHTML = 
                '<div class="result">' +
                '<h4>Bot Configurado com Sucesso!</h4>' +
                '<p><strong>Carteira:</strong> ' + result.wallet.address + '</p>' +
                '<p><strong>Trader:</strong> ' + result.config.traderAddress + '</p>' +
                '<p><strong>Estratégia:</strong> ' + result.config.strategy + '</p>' +
                '<p><strong>Modo:</strong> Preview (Seguro)</p>' +
                '<div class="links">' +
                '<strong>Links para Funding:</strong><br>' +
                '<a href="' + result.depositLinks.usdc + '" target="_blank">Bridge USDC para Polygon</a><br>' +
                '<a href="' + result.depositLinks.pol + '" target="_blank">Comprar POL (gás)</a><br>' +
                '<a href="/" target="_blank">Acessar Dashboard</a>' +
                '</div>' +
                '</div>';
        } else {
            document.getElementById('setupResult').innerHTML = 
                '<div class="error">Erro: ' + result.error + '</div>';
        }
    } catch (error) {
        document.getElementById('setupResult').innerHTML = 
            '<div class="error">Erro: ' + error.message + '</div>';
    }
    
    btn.disabled = false;
    btn.textContent = 'Configurar Bot';
}
</script>
</body>
</html>`;
    res.type('html').send(setupHtml);
});
// --- Web UI ---
const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyCopy SaaS Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0b0e14;
  --card: #151921;
  --border: #262c36;
  --text: #e1e7ef;
  --text-dim: #94a3b8;
  --accent: #3b82f6;
  --accent-glow: rgba(59, 130, 246, 0.4);
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
}
* { margin:0; padding:0; box-sizing:border-box; font-family: 'Outfit', sans-serif; }
body { background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
.container { max-width: 1400px; margin: 0 auto; }

header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
h1 { font-size: 1.8rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 12px; }
.logo-icon { width: 32px; height: 32px; background: var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px var(--accent-glow); }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 32px; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; position: relative; overflow: hidden; }
.stat-card::after { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(45deg, transparent, rgba(59, 130, 246, 0.05)); pointer-events: none; }
.stat-label { color: var(--text-dim); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.stat-value { font-size: 2rem; font-weight: 700; color: #fff; }
.stat-sub { font-size: 0.8rem; color: var(--success); margin-top: 4px; display: flex; align-items: center; gap: 4px; }

.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
h2 { font-size: 1.25rem; color: #fff; font-weight: 600; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; margin-bottom: 32px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 16px; color: var(--text-dim); font-size: 0.85rem; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border); }
td { padding: 16px; border-bottom: 1px solid var(--border); font-size: 0.95rem; }
tr:hover { background: rgba(255,255,255,0.02); }

.user-id { display: flex; align-items: center; gap: 8px; }
.avatar { width: 32px; height: 32px; background: #2d3748; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; }
.badge { padding: 4px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; }
.badge-ready { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
.badge-setup { background: rgba(245, 158, 11, 0.1); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.2); }

.switch { position: relative; display: inline-block; width: 44px; height: 24px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #333; transition: .4s; border-radius: 34px; }
.slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider { background-color: var(--accent); }
input:checked + .slider:before { transform: translateX(20px); }

.action-btn { background: #262c36; color: #fff; border: 1px solid #333; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 0.8rem; margin-right: 4px; transition: 0.2s; }
.action-btn:hover { border-color: var(--accent); color: var(--accent); }
.btn-reset { color: var(--warning); }
.btn-delete { color: var(--danger); }

/* Animation */
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.animate { animation: fadeIn 0.4s ease-out forwards; }

.modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); }
.modal-content { background: var(--card); margin: 10% auto; padding: 32px; border: 1px solid var(--border); width: 500px; border-radius: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
.form-group { margin-bottom: 16px; }
label { display: block; color: var(--text-dim); font-size: 0.85rem; margin-bottom: 8px; }
input, select { width: 100%; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 12px; border-radius: 8px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
.save-btn { background: var(--accent); color: #fff; border: none; padding: 10px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><div class="logo-icon">P</div> PolyCopy SaaS</h1>
    <div id="uptime" style="color: var(--text-dim); font-size: 0.9rem;">Uptime: ...</div>
  </header>

  <div class="stats-grid">
    <div class="stat-card animate">
      <div class="stat-label">Total de Usuários</div>
      <div id="st-users" class="stat-value">0</div>
      <div class="stat-sub"><span>↑</span> Registrados</div>
    </div>
    <div class="stat-card animate" style="animation-delay: 0.1s">
      <div class="stat-label">Usuários Ativos</div>
      <div id="st-active" class="stat-value">0</div>
      <div class="stat-sub"><span>◉</span> Trading agora</div>
    </div>
    <div class="stat-card animate" style="animation-delay: 0.2s">
      <div class="stat-label">Traders Monitorados</div>
      <div id="st-traders" class="stat-value">0</div>
      <div class="stat-sub"><span>◉</span> Unique traders</div>
    </div>
    <div class="stat-card animate" style="animation-delay: 0.3s">
      <div class="stat-label">Modo do Sistema</div>
      <div id="st-mode" class="stat-value" style="font-size: 1.5rem">PREVIEW</div>
      <div id="st-mode-sub" class="stat-sub">Safe mode active</div>
    </div>
  </div>

  <div class="section-header">
    <h2>Gerenciar Usuários</h2>
  </div>

  <div class="card animate" style="animation-delay: 0.4s">
    <table id="user-table">
      <thead>
        <tr>
          <th>Usuário (Telegram)</th>
          <th>Carteira (Bot)</th>
          <th>Trader Seguido</th>
          <th>Estratégia</th>
          <th>Status</th>
          <th>Ativo?</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody id="user-body">
        <tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-dim);">Carregando usuários...</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section-header">
    <h2>Trades Globais Recentes</h2>
  </div>
  <div class="card animate" style="animation-delay: 0.5s">
    <table id="trade-table">
      <thead>
        <tr>
          <th>Horário</th>
          <th>Follower</th>
          <th>Trader</th>
          <th>Lado</th>
          <th>Valor</th>
          <th>Mercado</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="trade-body"></tbody>
    </table>
  </div>
</div>

<!-- Modal Edit User -->
<div id="edit-modal" class="modal">
  <div class="modal-content">
    <h2 style="margin-bottom: 24px;">Editar Configuração de Usuário</h2>
    <input type="hidden" id="edit-chatid">
    <div class="form-group">
      <label>Trader Monitorado</label>
      <input type="text" id="edit-trader">
    </div>
    <div class="form-group">
      <label>Estratégia</label>
      <select id="edit-strategy">
        <option value="PERCENTAGE">Porcentagem (%)</option>
        <option value="FIXED">Valor Fixo ($)</option>
        <option value="ADAPTIVE">Adaptiva</option>
      </select>
    </div>
    <div class="form-group">
      <label>Tamanho (Copy Size)</label>
      <input type="number" id="edit-size" step="0.1">
    </div>
    <div class="modal-footer">
      <button class="action-btn" onclick="closeModal()">Cancelar</button>
      <button class="save-btn" onclick="saveUserConfig()">Salvar Alterações</button>
    </div>
  </div>
</div>

<script>
async function refresh() {
  try {
    const [status, users, trades] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/users').then(r => r.json()),
      fetch('/api/trades?limit=10').then(r => r.json())
    ]);

    document.getElementById('uptime').textContent = 'Uptime: ' + Math.floor(status.uptime/3600) + 'h ' + Math.floor((status.uptime%3600)/60) + 'm';
    document.getElementById('st-users').textContent = status.totalUsers;
    document.getElementById('st-active').textContent = status.activeUsers;
    
    // Count unique traders
    const tradersSet = new Set(users.map(u => u.config?.traderAddress).filter(a => !!a));
    document.getElementById('st-traders').textContent = tradersSet.size;
    
    const modeEl = document.getElementById('st-mode');
    const modeSubEl = document.getElementById('st-mode-sub');
    if (status.previewMode) {
      modeEl.textContent = 'PREVIEW';
      modeEl.style.color = 'var(--text)';
      modeSubEl.textContent = 'Modo seguro ativo';
      modeSubEl.style.color = 'var(--success)';
    } else {
      modeEl.textContent = 'REAL TRADES';
      modeEl.style.color = 'var(--accent)';
      modeSubEl.textContent = 'Execução real ativa';
      modeSubEl.style.color = 'var(--danger)';
    }

    // Update Users
    const userBody = document.getElementById('user-body');
    userBody.innerHTML = users.map(u => {
      const isReady = u.step === 'ready';
      return \`
        <tr>
          <td>
            <div class="user-id">
              <div class="avatar">\${u.chatId.slice(-2)}</div>
              <span>\${u.chatId}</span>
            </div>
          </td>
          <td style="font-family: monospace; font-size: 0.8rem">\${u.wallet?.address ? u.wallet.address.slice(0,6)+'...'+u.wallet.address.slice(-4) : '---'}</td>
          <td style="font-family: monospace; font-size: 0.8rem">\${u.config?.traderAddress ? u.config.traderAddress.slice(0,6)+'...'+u.config.traderAddress.slice(-4) : '---'}</td>
          <td>\${u.config?.strategy || '---'} (\${u.config?.copySize || 0}%)</td>
          <td><span class="badge \${isReady ? 'badge-ready' : 'badge-setup'}">\${u.step}</span></td>
          <td>
            <label class="switch">
              <input type="checkbox" \${u.config?.enabled ? 'checked' : ''} onchange="toggleUser('\${u.chatId}', this.checked)">
              <span class="slider"></span>
            </label>
          </td>
          <td>
            <button class="action-btn" onclick="openEditModal('\${u.chatId}', '\${u.config?.traderAddress}', '\${u.config?.strategy}', \${u.config?.copySize})">⚙️</button>
            <button class="action-btn btn-reset" onclick="resetUser('\${u.chatId}')">🔄</button>
            <button class="action-btn btn-delete" onclick="deleteUser('\${u.chatId}')">🗑️</button>
          </td>
        </tr>
      \`;
    }).join('');

    // Update Trades
    const tradeBody = document.getElementById('trade-body');
    tradeBody.innerHTML = trades.map(t => \`
      <tr>
        <td style="color: var(--text-dim); font-size: 0.8rem">\${new Date(t.timestamp).toLocaleTimeString()}</td>
        <td>\${t.processedBy?.length > 0 ? t.processedBy.join(', ') : '---'}</td>
        <td style="font-family: monospace; font-size: 0.8rem">\${t.traderAddress.slice(0,6)}...</td>
        <td><span style="color: \${t.side === 'BUY' ? 'var(--success)' : 'var(--danger)'}">\${t.side}</span></td>
        <td>$\${(t.usdcSize || 0).toFixed(2)}</td>
        <td style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${t.title || t.slug}</td>
        <td>\${t.bot ? '<span style="color: var(--success)">✓ Executado</span>' : '<span style="color: var(--text-dim)">Pendente</span>'}</td>
      </tr>
    \`).join('');

  } catch (e) {
    console.error('Refresh error:', e);
  }
}

async function toggleUser(chatId, enabled) {
  await fetch(\`/api/users/\${chatId}/config\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { enabled } })
  });
  refresh();
}

async function resetUser(chatId) {
  if (!confirm('Deseja resetar este usuário? A carteira será removida e ele voltará ao início.')) return;
  await fetch(\`/api/users/\${chatId}/reset\`, { method: 'POST' });
  refresh();
}

async function deleteUser(chatId) {
  if (!confirm('Deseja excluir permanentemente este usuário?')) return;
  await fetch(\`/api/users/\${chatId}\`, { method: 'DELETE' });
  refresh();
}

function openEditModal(chatId, trader, strategy, size) {
  document.getElementById('edit-chatid').value = chatId;
  document.getElementById('edit-trader').value = trader;
  document.getElementById('edit-strategy').value = strategy;
  document.getElementById('edit-size').value = size;
  document.getElementById('edit-modal').style.display = 'block';
}

function closeModal() {
  document.getElementById('edit-modal').style.display = 'none';
}

async function saveUserConfig() {
  const chatId = document.getElementById('edit-chatid').value;
  const config = {
    traderAddress: document.getElementById('edit-trader').value,
    strategy: document.getElementById('edit-strategy').value,
    copySize: parseFloat(document.getElementById('edit-size').value)
  };
  
  await fetch(\`/api/users/\${chatId}/config\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  
  closeModal();
  refresh();
}

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
const authStyles = `
:root {
  --bg: #0b0e14; --sidebar: #11151c; --card: #161b22; --border: #21262d;
  --text: #c9d1d9; --text-dim: #8b949e; --accent: #3b82f6; 
  --success: #238636; --warning: #d29922; --danger: #da3633;
  --font-main: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { 
  background: var(--bg); 
  color: var(--text); 
  font-family: var(--font-main); 
  display: flex; 
  align-items: center; 
  justify-content: center; 
  min-height: 100vh;
}
.auth-card { 
  width: 100%; 
  max-width: 420px; 
  background: var(--card); 
  border: 1px solid var(--border); 
  border-radius: 12px; 
  padding: 40px; 
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
}
.logo { font-size: 1.8rem; font-weight: 800; color: #fff; margin-bottom: 30px; text-align: center; }
.logo span { color: var(--accent); }
.form-group { margin-bottom: 20px; }
label { display: block; font-size: 0.75rem; color: var(--text-dim); margin-bottom: 8px; text-transform: uppercase; font-weight: 600; }
input { 
  width: 100%; 
  background: #0d1117; 
  border: 1px solid var(--border); 
  padding: 12px 16px; 
  color: #fff; 
  border-radius: 6px; 
  font-size: 1rem;
  outline: none;
  transition: 0.2s;
}
input:focus { border-color: var(--accent); }
.btn-auth {
  width: 100%;
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 700;
  font-size: 1rem;
  transition: 0.2s;
}
.btn-auth:hover { background: #2563eb; transform: translateY(-1px); }
.footer { margin-top: 25px; text-align: center; font-size: 0.85rem; color: var(--text-dim); }
.footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
`;
const loginHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prediz Copy | Login</title>
  <style>${authStyles}</style>
</head>
<body>
  <div class="auth-card">
    <div class="logo">PREDIZ<span>COPY</span></div>
    <form id="loginForm">
      <div class="form-group">
        <label>Identificação / E-mail</label>
        <input type="text" id="identity" placeholder="Seu usuário ou e-mail" required>
      </div>
      <div class="form-group">
        <label>Senha de Acesso</label>
        <input type="password" id="password" placeholder="••••••••" required>
      </div>
      <button type="submit" class="btn-auth">Entrar no Sistema</button>
    </form>
    <div id="error" style="color: var(--danger); margin-top: 15px; font-size: 0.85rem; text-align: center"></div>
    <div class="footer">
      Não tem uma conta? <a href="/signup">Criar Cadastro</a>
    </div>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const identity = document.getElementById('identity').value;
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, password })
      });
      const data = await res.json();
      if (data.success) window.location.href = '/';
      else document.getElementById('error').textContent = data.error;
    };
  </script>
</body> </html>`;
const signupHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prediz Copy | Cadastro</title>
  <style>${authStyles}</style>
</head>
<body>
  <div class="auth-card">
    <div class="logo">PREDIZ<span>COPY</span></div>
    <form id="signupForm">
      <div class="form-group">
        <label>Nome de Usuário</label>
        <input type="text" id="username" placeholder="Como deseja ser chamado" required>
      </div>
      <div class="form-group">
        <label>E-mail</label>
        <input type="email" id="email" placeholder="seu@email.com" required>
      </div>
      <div class="form-group">
        <label>Senha de Acesso</label>
        <input type="password" id="password" placeholder="Mínimo 6 caracteres" required>
      </div>
      <button type="submit" class="btn-auth">Finalizar Cadastro</button>
    </form>
    <div id="error" style="color: var(--danger); margin-top: 15px; font-size: 0.85rem; text-align: center"></div>
    <div class="footer">
      Já possui cadastro? <a href="/login">Fazer Login</a>
    </div>
  </div>
  <script>
    document.getElementById('signupForm').onsubmit = async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (data.success) window.location.href = '/';
      else document.getElementById('error').textContent = data.error;
    };
  </script>
</body> </html>`;
const adminDashboardHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyCopy SaaS Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0b0e14; --sidebar: #11151c; --card: #161b22; --border: #21262d;
  --text: #c9d1d9; --text-dim: #8b949e; --accent: #3b82f6; 
  --success: #238636; --warning: #d29922; --danger: #da3633;
  --font-main: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font-main); display: flex; min-height: 100vh; overflow-x: hidden; }

/* Sidebar */
aside { width: 240px; background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; height: 100vh; transition: 0.3s; z-index: 1000; }
.logo { padding: 25px; font-size: 1.3rem; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); }
.logo span { color: var(--accent); }
.nav { flex: 1; padding: 15px 0; }
.nav-item { padding: 12px 25px; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 10px; transition: 0.1s; font-size: 0.9rem; }
.nav-item:hover { color: #fff; background: rgba(255,255,255,0.03); }
.nav-item.active { color: #fff; background: rgba(59, 130, 246, 0.1); border-right: 3px solid var(--accent); }

/* Main Content */
main { flex: 1; margin-left: 240px; padding: 30px; width: calc(100% - 240px); }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
.user-info { display: flex; align-items: center; gap: 12px; }
.avatar { width: 32px; height: 32px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
.stat-card { background: var(--card); border: 1px solid var(--border); padding: 20px; border-radius: 8px; }
.stat-label { color: var(--text-dim); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.stat-value { font-size: 1.8rem; font-weight: 700; color: #fff; }
.stat-sub { font-size: 0.75rem; margin-top: 6px; font-family: monospace; }

/* Tables & Content */
.section { display: none; width: 100%; }
.section.active { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
h2 { margin-bottom: 20px; font-size: 1.1rem; font-weight: 700; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 16px 24px; color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border); letter-spacing: 1px; }
td { padding: 16px 24px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
tr:hover { background: rgba(59, 130, 246, 0.02); }

/* Badges & Buttons */
.badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; font-family: var(--font-mono); }
.badge-ready { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
.badge-setup { background: rgba(245, 158, 11, 0.1); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.2); }

.switch { position: relative; display: inline-block; width: 42px; height: 22px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #334155; transition: .4s; border-radius: 34px; }
.slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider { background-color: var(--accent); }
input:checked + .slider:before { transform: translateX(20px); }

.btn { background: #2d343f; color: #fff; border: 1px solid var(--border); padding: 8px 14px; border-radius: 8px; cursor: pointer; transition: 0.2s; font-size: 0.85rem; font-weight: 600; }
.btn:hover { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 10px rgba(59, 130, 246, 0.1); }
.btn-accent { background: var(--accent); border: none; }
.btn-accent:hover { background: #2563eb; color: #fff; }
.btn-danger { color: var(--danger); }
.btn-danger:hover { color: #fff; background: var(--danger); border-color: var(--danger); }
.btn-warning { color: var(--warning); }
.btn-warning:hover { color: #000; background: var(--warning); border-color: var(--warning); }

/* Modal */
.modal { display: none; position: fixed; z-index: 2000; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); overflow-y: auto; }
.modal-content { background: var(--sidebar); margin: 40px auto; padding: 32px; border: 1px solid var(--border); width: 700px; max-width: 95%; border-radius: 24px; box-shadow: 0 30px 60px rgba(0,0,0,0.5); }
.form-group { margin-bottom: 20px; }
label { display: block; color: var(--text-dim); font-size: 0.85rem; margin-bottom: 8px; font-weight: 500; }
input, select { width: 100%; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 12px; border-radius: 10px; font-family: var(--font-main); transition: 0.3s; }
input:focus, select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1); }
.modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 32px; }

/* Config Cards */
.config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 30px; }
.config-group { background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); padding: 25px; border-radius: 16px; }
.config-group h3 { font-size: 0.9rem; color: var(--accent); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }

#message-banner { margin-bottom: 20px; padding: 15px 24px; border-radius: 10px; font-weight: 600; display: none; animation: slideIn 0.3s ease; }
@keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
.success-banner { background: rgba(16, 185, 129, 0.1); border: 1px solid var(--success); color: var(--success); }
.error-banner { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); color: var(--danger); }
</style>
</head>
<body>
  <aside>
    <div class="logo">PREDIZ<span>COPY</span></div>
    <div class="nav">
      <div class="nav-item active" onclick="showSection('dashboard', this)">
        <span>📊</span> Dashboard
      </div>
      <div class="nav-item" onclick="showSection('users', this)">
        <span>👥</span> Gerenciar Usuários
      </div>
      <div class="nav-item" onclick="showSection('config', this)">
        <span>⚙️</span> Configurações Globais
      </div>
      <div class="nav-item" onclick="showSection('logs', this)">
        <span>📜</span> Logs de Trading
      </div>
    </div>
    <div style="padding: 30px; border-top: 1px solid var(--border)">
      <button onclick="logout()" class="btn" style="width: 100%; color: var(--danger); border-color: var(--danger)">Sair do Painel</button>
    </div>
  </aside>

  <main>
    <header>
      <h2 id="section-title">Dashboard Overview</h2>
      <div class="user-info">
        <div style="text-align: right">
          <div id="admin-name" style="font-weight: 700; color: #fff">Admin User</div>
          <div id="admin-badge" class="badge badge-ready">PANEL_ADMIN</div>
        </div>
        <div class="avatar">A</div>
      </div>
    </header>

    <div id="message-banner"></div>

    <!-- Section: Dashboard -->
    <div id="section-dashboard" class="section active">
      <div class="grid">
        <div class="stat-card">
          <div class="stat-label">Total de Usuários</div>
          <div id="st-total-users" class="stat-value">0</div>
          <div class="stat-sub" style="color: var(--success)">SaaS Members</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Usuários Ativos</div>
          <div id="st-active-users" class="stat-value">0</div>
          <div class="stat-sub" style="color: var(--accent)">Bots Executando</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Modo do Sistema</div>
          <div id="st-sys-mode" class="stat-value" style="font-size: 1.5rem">PREVIEW</div>
          <div id="st-sys-sub" class="stat-sub" style="color: var(--warning)">Seguro (Simulação)</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Uptime do Servidor</div>
          <div id="st-uptime" class="stat-value" style="font-size: 1.5rem">00:00:00</div>
          <div class="stat-sub">Serviços Online</div>
        </div>
      </div>

      <h2>Atividade Recente (Global)</h2>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Follower</th>
              <th>Recurso</th>
              <th>Vetor</th>
              <th>Tamanho</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody id="dash-trade-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Section: Users -->
    <div id="section-users" class="section">
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Identidade</th>
              <th>Carteira Operacional</th>
              <th>Estratégia / Trader</th>
              <th>Status Bot</th>
              <th>Ativo?</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody id="user-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Section: Config -->
    <div id="section-config" class="section">
      <div class="config-grid">
        <div class="config-group">
          <h3>Estratégia de Cópia Global</h3>
          <div class="form-group">
            <label>Tipo de Cálculo</label>
            <select id="copyStrategy">
              <option value="PERCENTAGE">Porcentagem (Proporcional)</option>
              <option value="FIXED">Valor Fixo (USD)</option>
              <option value="ADAPTIVE">Adaptativa (IA)</option>
            </select>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px">
            <div class="form-group">
              <label>Tamanho Padrão (%)</label>
              <input type="number" id="copySize" step="0.1">
            </div>
            <div class="form-group">
              <label>Limite Max USD</label>
              <input type="number" id="maxOrderSize" step="1">
            </div>
          </div>
        </div>

        <div class="config-group">
          <h3>Infraestrutura (Variaveis Sensíveis)</h3>
          <div class="form-group">
            <label>RPC URL (Polygon)</label>
            <input type="url" id="rpcUrl">
          </div>
          <div class="form-group">
            <label>Check Interval (Segundos)</label>
            <input type="number" id="fetchInterval">
          </div>
          <div class="form-group" style="display:flex; align-items:center; gap:12px; margin-top:10px">
            <input type="checkbox" id="previewMode" style="width:20px; height:20px; accent-color:var(--accent)">
            <label style="margin-bottom:0">MODO_PREVIEW_GLOBAL (Simulação Segura)</label>
          </div>
        </div>
      </div>
      <div class="card" style="padding: 24px; margin-top: 30px; display: flex; gap: 15px">
        <button onclick="saveGlobalConfig()" class="btn btn-accent" style="padding: 12px 30px">Aplicar Mudanças Globais</button>
        <button onclick="resetToDefaults()" class="btn btn-warning">Resetar para Padrões</button>
      </div>
    </div>

    <!-- Section: Logs -->
    <div id="section-logs" class="section">
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>ID da Transação</th>
              <th>Vetor</th>
              <th>Volume</th>
              <th>Status de Rede</th>
            </tr>
          </thead>
          <tbody id="log-trade-body"></tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- Modal Edit User -->
  <div id="modal-edit" class="modal">
    <div class="modal-content">
      <h2 style="margin-bottom:24px; color: var(--accent); display: flex; align-items: center; gap: 10px">
        <span>⚙️</span> Configurar Membro SaaS
      </h2>
      <input type="hidden" id="edit-chatId">
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px">
        <!-- Coluna 1: Básico & Conta -->
        <div>
          <div style="margin-bottom: 20px; padding: 12px; background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 8px">
            <h3 style="margin-bottom: 12px; font-size: 0.85rem; color: var(--accent); display: flex; align-items: center; gap: 8px">
              👤 Conta do Usuário
            </h3>
            <div class="form-group">
                <label>Nome / Usuário</label>
                <input type="text" id="edit-username" placeholder="Nome">
            </div>
            <div class="form-group">
                <label>E-mail</label>
                <input type="email" id="edit-email" placeholder="email@exemplo.com">
            </div>
            <div class="form-group" style="margin-bottom: 0">
                <label>Nova Senha</label>
                <input type="password" id="edit-password" placeholder="•••••••• (deixe vazio)">
            </div>
          </div>

          <div class="form-group">
            <label>Endereço do Trader Monitorado</label>
            <input type="text" id="edit-trader" placeholder="0x...">
          </div>
          <div class="form-group">
            <label>Estratégia de Cópia</label>
            <select id="edit-strategy">
              <option value="PERCENTAGE">Percentage (%)</option>
              <option value="FIXED">Fixed (USD)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Tamanho da Cópia (Valor/%)</label>
            <input type="number" id="edit-size" step="0.1">
          </div>
          <div class="form-group">
            <label>Tipo de Ordem</label>
            <select id="edit-orderType">
              <option value="MARKET">Market (Instantânea)</option>
              <option value="LIMIT">Limit (Preço Alvo)</option>
            </select>
          </div>
          <div class="form-group" style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
            <div>
              <label>Slippage Compra (%)</label>
              <input type="number" id="edit-slippageBuy" step="0.01">
            </div>
            <div>
              <label>Slippage Venda (%)</label>
              <input type="number" id="edit-slippageSell" step="0.01">
            </div>
          </div>
        </div>

        <!-- Coluna 2: Avançado -->
        <div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
            <div class="form-group">
              <label>Preço Mínimo ($)</label>
              <input type="number" id="edit-minPrice" step="0.01">
            </div>
            <div class="form-group">
              <label>Preço Máximo ($)</label>
              <input type="number" id="edit-maxPrice" step="0.01">
            </div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
            <div class="form-group">
              <label>Trade Mínimo ($)</label>
              <input type="number" id="edit-minTrade" step="1">
            </div>
            <div class="form-group">
              <label>Trade Máximo ($)</label>
              <input type="number" id="edit-maxTrade" step="1">
            </div>
          </div>
          
          <div style="margin-top: 15px; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 12px; border: 1px solid var(--border)">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
               <input type="checkbox" id="edit-reverse" style="width:18px; height:18px">
               <label style="margin-bottom:0">Reverse Copy (Inverter Lado)</label>
            </div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
               <input type="checkbox" id="edit-copyBuy" style="width:18px; height:18px">
               <label style="margin-bottom:0">Copiar Compras (BUY)</label>
            </div>
            <div style="display: flex; align-items: center; gap: 10px">
               <input type="checkbox" id="edit-copySell" style="width:18px; height:18px">
               <label style="margin-bottom:0">Copiar Vendas (SELL)</label>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button onclick="closeModal()" class="btn">Cancelar</button>
        <button onclick="commitUserEdit()" class="btn btn-accent" style="padding-left: 30px; padding-right: 30px">Aplicar Configurações</button>
      </div>
    </div>
  </div>

  <script>
    function showSection(id, el) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('section-' + id).classList.add('active');
      el.classList.add('active');
      document.getElementById('section-title').textContent = id.charAt(0).toUpperCase() + id.slice(1);
      if (id === 'config') loadGlobalConfig();
    }

    async function refresh() {
      try {
        const [status, users, trades] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/users').then(r => r.json()),
          fetch('/api/trades?limit=20').then(r => r.json())
        ]);

        // Stats
        document.getElementById('admin-name').textContent = status.username || 'Admin';
        document.getElementById('st-total-users').textContent = status.totalUsers;
        document.getElementById('st-active-users').textContent = status.activeUsers;
        document.getElementById('st-uptime').textContent = formatUptime(status.uptime);
        
        const modeEl = document.getElementById('st-sys-mode');
        const modeSubEl = document.getElementById('st-sys-sub');
        if (status.previewMode) {
          modeEl.textContent = 'PREVIEW';
          modeEl.style.color = 'var(--text)';
          modeSubEl.textContent = 'Simulação Segura Ativa';
          modeSubEl.style.color = 'var(--warning)';
        } else {
          modeEl.textContent = 'PRODUCTION';
          modeEl.style.color = 'var(--success)';
          modeSubEl.textContent = 'Operação Real em Chain';
          modeSubEl.style.color = 'var(--success)';
        }

        // Users Table
        document.getElementById('user-body').innerHTML = users.map(u => \`
          <tr>
            <td>
              <div style="font-weight: 700; color: #fff">\${u.username || u.chatId}</div>
              <div style="font-size: 0.7rem; color: var(--text-dim)">\${u.email || 'Web Session'}</div>
            </td>
            <td style="font-family: var(--font-mono); font-size: 0.75rem">\${u.wallet?.address || '---'}</td>
            <td>
              <div style="font-size: 0.75rem; color: var(--text-dim)">Seguindo: \${u.config?.traderAddress?.slice(0,10) || 'Nenhum'}</div>
              <div style="font-weight: 600">\${u.config?.strategy} (\${u.config?.copySize})</div>
            </td>
            <td><span class="badge \${u.step === 'ready' ? 'badge-ready' : 'badge-setup'}">\${u.step.toUpperCase()}</span></td>
            <td>
              <label class="switch">
                <input type="checkbox" \${u.config?.enabled ? 'checked' : ''} onchange="toggleUser('\${u._id}', this.checked)">
                <span class="slider"></span>
              </label>
            </td>
            <td>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-accent" style="padding: 4px 8px" onclick="editUser('\${u._id}')">⚙️</button>
                <button class="btn btn-warning" style="padding: 4px 8px" onclick="resetUser('\${u._id}')">🔄</button>
                <button class="btn btn-danger" style="padding: 4px 8px" onclick="deleteUser('\${u._id}')">🗑️</button>
              </div>
            </td>
          </tr>
        \`).join('');

        // Trade Tables (Dash and Logs)
        const tradesHtml = trades.map(t => \`
          <tr>
            <td style="font-size: 0.75rem; color: var(--text-dim)">\${new Date(t.timestamp).toLocaleString()}</td>
            <td style="font-weight: 500">\${t.chatId || 'System'}</td>
            <td style="font-size: 0.8rem; max-width: 150px; overflow: hidden; text-overflow: ellipsis">\${t.title || t.slug}</td>
            <td><span style="color: \${t.side === 'BUY' ? 'var(--success)' : 'var(--danger)'}">\${t.side}</span></td>
            <td style="font-weight: 700">$\${(t.usdcSize || 0).toFixed(2)}</td>
            <td><span style="color: \${t.bot ? 'var(--success)' : 'var(--warning)'}">\${t.bot ? 'EXECUTED' : 'PENDING'}</span></td>
          </tr>
        \`).join('');
        document.getElementById('dash-trade-body').innerHTML = tradesHtml;
        document.getElementById('log-trade-body').innerHTML = tradesHtml; // Detailed view could be richer

      } catch (e) { console.error('Refresh failed:', e); }
    }

    async function toggleUser(id, enabled) {
      await fetch(\`/api/users/\${id}/config\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { enabled } })
      });
      showBanner(enabled ? 'Membro SaaS Ativado' : 'Bot Suspenso', 'success');
      refresh();
    }

    async function editUser(id) {
      try {
        const res = await fetch(\`/api/users/\${id}\`);
        const u = await res.json();
        const c = u.config || {};
        
        document.getElementById('edit-chatId').value = u._id || u.chatId;
        document.getElementById('edit-username').value = u.username || '';
        document.getElementById('edit-email').value = u.email || '';
        document.getElementById('edit-password').value = ''; // Sempre limpo ao abrir
        
        document.getElementById('edit-trader').value = c.traderAddress || '';
        document.getElementById('edit-strategy').value = c.strategy || 'PERCENTAGE';
        document.getElementById('edit-size').value = c.copySize || 0;
        document.getElementById('edit-orderType').value = c.orderType || 'MARKET';
        document.getElementById('edit-slippageBuy').value = c.slippageBuy || 0.05;
        document.getElementById('edit-slippageSell').value = c.slippageSell || 0.05;
        document.getElementById('edit-minPrice').value = c.minPrice || 0;
        document.getElementById('edit-maxPrice').value = c.maxPrice || 1.0;
        document.getElementById('edit-minTrade').value = c.minTradeSize || 0;
        document.getElementById('edit-maxTrade').value = c.maxTradeSize || 1000;
        document.getElementById('edit-reverse').checked = !!c.reverseCopy;
        document.getElementById('edit-copyBuy').checked = c.copyBuy !== false;
        document.getElementById('edit-copySell').checked = c.copySell !== false;
        
        document.getElementById('modal-edit').style.display = 'block';
      } catch (e) { showBanner('Erro ao carregar usuário', 'danger'); }
    }

    async function commitUserEdit() {
      const id = document.getElementById('edit-chatId').value;
      const username = document.getElementById('edit-username').value.trim();
      const email = document.getElementById('edit-email').value.trim();
      const password = document.getElementById('edit-password').value.trim();

      const config = {
        traderAddress: document.getElementById('edit-trader').value,
        strategy: document.getElementById('edit-strategy').value,
        copySize: parseFloat(document.getElementById('edit-size').value),
        orderType: document.getElementById('edit-orderType').value,
        slippageBuy: parseFloat(document.getElementById('edit-slippageBuy').value),
        slippageSell: parseFloat(document.getElementById('edit-slippageSell').value),
        minPrice: parseFloat(document.getElementById('edit-minPrice').value),
        maxPrice: parseFloat(document.getElementById('edit-maxPrice').value),
        minTradeSize: parseFloat(document.getElementById('edit-minTrade').value),
        maxTradeSize: parseFloat(document.getElementById('edit-maxTrade').value),
        reverseCopy: document.getElementById('edit-reverse').checked,
        copyBuy: document.getElementById('edit-copyBuy').checked,
        copySell: document.getElementById('edit-copySell').checked
      };
      
      const payload = { config };
      if (username) payload.username = username;
      if (email) payload.email = email;
      if (password) payload.password = password;

      const res = await fetch(\`/api/users/\${id}/config\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        showBanner('Configurações do Membro Atualizadas', 'success');
        closeModal();
        refresh();
      } else {
        showBanner('Falha ao atualizar configurações', 'danger');
      }
    }

     async function resetUser(id) {
      if (!confirm('CONFIRMAR RESET? Isso limpará a carteira e o fluxo do usuário.')) return;
      try {
        const res = await fetch(\`/api/users/\${id}/reset\`, { method: 'POST' });
        if (res.ok) {
          showBanner('Usuário resetado com sucesso', 'warning');
          refresh();
        } else {
          showBanner('Erro ao resetar usuário', 'danger');
        }
      } catch (e) {
        showBanner('Erro de conexão ao resetar', 'danger');
      }
    }

    async function deleteUser(id) {
      if (!confirm('CONFIRMAR EXCLUSÃO PERMANENTE?')) return;
      try {
        const res = await fetch(\`/api/users/\${id}\`, { method: 'DELETE' });
        if (res.ok) {
          showBanner('Membro excluído do SaaS', 'danger');
          refresh();
        } else {
          const data = await res.json();
          showBanner(data.error || 'Erro ao excluir usuário', 'danger');
        }
      } catch (e) {
        showBanner('Erro de conexão ao excluir', 'danger');
      }
    }

    async function loadGlobalConfig() {
      const res = await fetch('/api/config/advanced');
      const c = await res.json();
      document.getElementById('copyStrategy').value = c.copyStrategy;
      document.getElementById('copySize').value = c.copySize;
      document.getElementById('maxOrderSize').value = c.maxOrderSize;
      document.getElementById('rpcUrl').value = c.rpcUrl;
      document.getElementById('fetchInterval').value = c.fetchInterval;
      document.getElementById('previewMode').checked = c.previewMode === 'true';
    }

    async function saveGlobalConfig() {
      const config = {
        copyStrategy: document.getElementById('copyStrategy').value,
        copySize: document.getElementById('copySize').value,
        maxOrderSize: document.getElementById('maxOrderSize').value,
        rpcUrl: document.getElementById('rpcUrl').value,
        fetchInterval: document.getElementById('fetchInterval').value,
        previewMode: document.getElementById('previewMode').checked.toString()
      };
      const res = await fetch('/api/config/advanced', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) showBanner('Configurações Globais Aplicadas', 'success');
    }

    function formatUptime(s) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return [h, m, sec].map(v => v < 10 ? '0' + v : v).join(':');
    }

    function showBanner(msg, type) {
      const b = document.getElementById('message-banner');
      b.textContent = msg.toUpperCase();
      b.className = type + '-banner';
      b.style.display = 'block';
      setTimeout(() => b.style.display = 'none', 4000);
    }

    function closeModal() { document.getElementById('modal-edit').style.display = 'none'; }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body> </html>`;
app.get('/login', (req, res) => {
    if (req.cookies.auth_token)
        return res.redirect('/');
    res.type('html').send(loginHtml);
});
app.get('/signup', (req, res) => {
    if (req.cookies.auth_token)
        return res.redirect('/');
    res.type('html').send(signupHtml);
});
const userDashboardHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prediz Copy Web Bot</title>
<style>
:root {
  --bg: #0b0e14; --sidebar: #11151c; --card: #161b22; --border: #21262d;
  --text: #c9d1d9; --text-dim: #8b949e; --accent: #3b82f6; 
  --success: #238636; --warning: #d29922; --danger: #da3633;
  --font-main: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font-main); display: flex; min-height: 100vh; overflow-x: hidden; }
aside { width: 240px; background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; height: 100vh; z-index: 100; }
.logo { padding: 25px; font-size: 1.3rem; font-weight: 800; color: #fff; border-bottom: 1px solid var(--border); }
.logo span { color: var(--accent); }
.nav { flex: 1; padding: 15px 0; }
.nav-item { padding: 12px 25px; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 10px; transition: 0.1s; font-size: 0.9rem; }
.nav-item:hover { color: #fff; background: rgba(255,255,255,0.05); }
.nav-item.active { color: #fff; background: rgba(59, 130, 246, 0.1); border-right: 3px solid var(--accent); }
main { flex: 1; margin-left: 240px; padding: 30px; width: calc(100% - 240px); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 20px; }
.wizard-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 40px; max-width: 700px; margin: 40px auto; }
.form-group { margin-bottom: 15px; }
label { display: block; color: var(--text-dim); font-size: 0.75rem; font-weight: 600; margin-bottom: 6px; text-transform: uppercase; }
input, select { width: 100%; background: #0d1117; border: 1px solid var(--border); color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 0.9rem; outline: none; }
input:focus { border-color: var(--accent); }
.btn { width: 100%; background: var(--accent); color: #fff; border: none; padding: 12px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.9rem; transition: 0.2s; }
.btn:hover { background: #2563eb; }
.btn-sm { padding: 8px 16px; width: auto; font-size: 0.8rem; }
.btn-outline { background: transparent; border: 1px solid var(--border); }
.btn-outline:hover { background: rgba(255,255,255,0.05); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 10px; font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; border-bottom: 1px solid var(--border); }
td { padding: 12px 10px; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
.badge { padding: 4px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; background: var(--bg); border: 1px solid var(--border); }
.status-active { color: var(--success); }
.status-paused { color: var(--warning); }
.step-indicator { display: flex; justify-content: space-between; margin-bottom: 30px; }
.step { width: 30px; height: 30px; border-radius: 50%; background: var(--bg); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--text-dim); }
.step.active { border-color: var(--accent); color: var(--accent); }
.step.done { background: var(--accent); border-color: var(--accent); color: #fff; }
#message-banner { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-weight: 600; display: none; z-index: 10000; background: var(--accent); color: #fff; }
.switch-container { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.85rem; }
</style>
</head>
<body>
  <aside>
    <div class="logo">PREDIZ<span>COPY</span></div>
    <div class="nav">
      <div id="nav-bot" class="nav-item active" onclick="switchTab('bot')"><span>🤖</span> Meu Robô</div>
      <div id="nav-positions" class="nav-item" onclick="switchTab('positions')"><span>📍</span> Posições Abertas</div>
      <div id="nav-config" class="nav-item" onclick="switchTab('config')"><span>⚙️</span> Configurações</div>
      <div class="nav-item" onclick="logout()" style="margin-top: 40px"><span>🚫</span> Sair</div>
    </div>
  </aside>
  <main>
    <div id="setup-wizard" class="wizard-card" style="display:none">
        <h2 id="wizard-title" style="margin-bottom: 8px">🤖 Configuração Inicial</h2>
        <p id="wizard-desc" style="color: var(--text-dim); margin-bottom: 30px; font-size: 0.9rem">Siga os passos para ativar sua cópia automática.</p>
        <div class="step-indicator">
            <div id="s1" class="step active">1</div>
            <div id="s2" class="step">2</div>
            <div id="s3" class="step">3</div>
        </div>
        <div id="step-content"></div>
    </div>

    <div id="tab-bot" class="tab-view">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px">
            <div>
                <h1 style="font-size: 1.8rem">Dashboard <span>Bot</span></h1>
                <p style="color: var(--text-dim); font-size: 0.9rem">Acompanhe suas operações em tempo real.</p>
            </div>
            <div id="bot-status-container" style="display: flex; align-items: center; gap: 20px">
                <div style="text-align: right">
                    <div style="font-size: 0.7rem; color: var(--text-dim); font-weight: 700">STATUS ATUAL</div>
                    <div id="bot-status-text" class="status-active" style="font-weight: 800; font-size: 1.1rem">ATIVO</div>
                </div>
                <button id="bot-master-btn" class="btn btn-sm" onclick="toggleBotMain()" style="width: 140px">DESATIVAR</button>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 24px">
            <div class="card" style="padding: 15px; display: flex; align-items: center; gap: 15px">
                <div style="background: rgba(59, 130, 246, 0.1); width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem">💰</div>
                <div>
                    <div style="font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px">Saldo Disponível</div>
                    <div id="stat-balance" style="font-weight: 700; font-size: 1.1rem; color: #fff">$0.00</div>
                </div>
            </div>
            <div class="card" style="padding: 15px; display: flex; align-items: center; gap: 15px">
                <div style="background: rgba(16, 185, 129, 0.1); width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem">📊</div>
                <div>
                    <div style="font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px">Volume em Posições</div>
                    <div id="stat-exposure" style="font-weight: 700; font-size: 1.1rem; color: var(--success)">$0.00</div>
                </div>
            </div>
            <div class="card" style="padding: 15px; display: flex; align-items: center; gap: 15px">
                <div style="background: rgba(245, 158, 11, 0.1); width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem">🎯</div>
                <div>
                    <div style="font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px">Trader Monitorado</div>
                    <div id="stat-trader" style="font-weight: 700; font-size: 0.9rem; color: #fff">Desconhecido</div>
                </div>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr; gap: 24px; margin-bottom: 24px">
            <div class="card" style="display: flex; align-items: center; justify-content: space-between; padding: 20px">
                <div style="display: flex; align-items: center; gap: 15px">
                    <div id="trader-avatar" style="width: 45px; height: 45px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; border: 1px solid var(--border)">👤</div>
                    <div>
                        <div id="trader-name" style="font-weight: 700; color: #fff">Nenhum</div>
                        <div id="trader-addr-display" style="font-family: var(--font-mono); font-size: 0.7rem; color: var(--accent)">0x...</div>
                    </div>
                </div>
                <button class="btn btn-sm btn-outline" onclick="switchTab('config')" style="width: auto; padding: 10px 20px">Configurações do Bot</button>
            </div>
        </div>

        <div class="card">
            <h3 style="margin-bottom: 20px; font-size: 1.1rem">Atividades Recentes</h3>
            <div style="overflow-x: auto">
                <table>
                    <thead>
                        <tr>
                            <th>DATA/HORA</th>
                            <th>MERCADO</th>
                            <th>LADO</th>
                            <th>VALOR TRADER</th>
                            <th>ENTRADA</th>
                            <th>ATUAL</th>
                            <th>P&L TRADER</th>
                            <th title="Quanto você colocou nessa operação">MINHA ENTRADA</th>
                            <th title="Seu lucro/prejuízo atual em USD">MEU LUCRO</th>
                            <th>STATUS</th>
                        </tr>
                    </thead>
                    <tbody id="user-trade-body"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div id="tab-positions" class="tab-view" style="display: none">
        <h1 style="margin-bottom: 10px">Suas Posições <span>Abertas</span></h1>
        <p style="color: var(--text-dim); margin-bottom: 30px">Visualize seus tokens ativos e como andam em tempo real. O TP/SL usará essas informações.</p>
        
        <div class="card">
            <div style="overflow-x: auto">
                <table>
                    <thead>
                        <tr>
                            <th>MERCADO</th>
                            <th>ATIVO</th>
                            <th>ENTRADA</th>
                            <th>ATUAL</th>
                            <th>QTD TOKENS</th>
                            <th>VALOR (USD)</th>
                            <th>P&L (%)</th>
                        </tr>
                    </thead>
                    <tbody id="user-positions-body">
                        <tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-dim)">Carregando posições...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <div id="tab-config" class="tab-view" style="display: none">
        <h1 style="margin-bottom: 10px">Configurações <span>Avançadas</span></h1>
        <p style="color: var(--text-dim); margin-bottom: 30px">Ajuste os parâmetros de risco e execução do seu bot.</p>

        <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 24px">
            <!-- COLUNA ESQUERDA: ESTRATÉGIA E EXECUÇÃO -->
            <div style="display: flex; flex-direction: column; gap: 24px">
                <div class="card">
                    <h3 style="margin-bottom: 24px; display: flex; align-items: center; gap: 8px"><span>🎯</span> Trader & Estratégia</h3>
                    <div class="form-group">
                        <label>Modo de Operação</label>
                        <select id="bot-mode">
                            <option value="COPY">COPY: Cópia Inteligente (Com Filtros)</option>
                            <option value="MIRROR_100">MIRROR: 100% Espelhamento (Sem Filtros)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Endereço do Trader Monitorado</label>
                        <input type="text" id="bot-trader" placeholder="0x...">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px">
                        <div class="form-group">
                            <label>Estratégia</label>
                            <select id="bot-strategy">
                                <option value="PERCENTAGE">Porcentagem (%)</option>
                                <option value="FIXED">Valor Fixo ($)</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Valor / %</label>
                            <input type="number" id="bot-size" step="0.1">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Tipo de Ordem</label>
                        <select id="bot-orderType">
                            <option value="MARKET">Market (Execução Rápida)</option>
                            <option value="LIMIT">Limit (Preço Específico)</option>
                        </select>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px">
                        <div class="form-group">
                            <label>Slippage Compra (%)</label>
                            <input type="number" id="bot-slippageBuy" step="0.01">
                        </div>
                        <div class="form-group">
                            <label>Slippage Venda (%)</label>
                            <input type="number" id="bot-slippageSell" step="0.01">
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin-bottom: 24px; display: flex; align-items: center; gap: 8px"><span>⚡</span> Execução & Filtros de Cópia</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; opacity: 0.5; pointer-events: none; filter: grayscale(1)">
                        <div class="form-group">
                            <label>Trigger Delta ($) [Arbitrage]</label>
                            <input type="number" id="bot-triggerDelta" step="0.001">
                        </div>
                        <div class="form-group">
                            <label>Hedge Ceiling ($) [Arbitrage]</label>
                            <input type="number" id="bot-hedgeCeiling" step="0.01">
                        </div>
                    </div>
                    
                    <div style="margin-top: 24px; display: grid; gap: 12px">
                        <label class="switch-container">
                            <input type="checkbox" id="bot-buyAtMin"> <span>Comprar Mínimo ($1) se cálculo for menor</span>
                        </label>
                        <label class="switch-container">
                            <input type="checkbox" id="bot-reverse"> <span>Reverse Copy (Operar contra o Trader)</span>
                        </label>
                        <label class="switch-container">
                            <input type="checkbox" id="bot-copyBuy" checked> <span>Copiar Ordens de COMPRA</span>
                        </label>
                        <label class="switch-container">
                            <input type="checkbox" id="bot-copySell" checked> <span>Copiar Ordens de VENDA</span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- COLUNA DIREITA: RISCO E SALVAMENTO -->
            <div style="display: flex; flex-direction: column; gap: 24px">
                <div class="card">
                    <h3 style="margin-bottom: 24px; display: flex; align-items: center; gap: 8px"><span>🛡️</span> Filtros de Risco</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px">
                        <div class="form-group">
                            <label>Preço Mínimo</label>
                            <input type="number" id="bot-minPrice" step="0.01">
                        </div>
                        <div class="form-group">
                            <label>Preço Máximo</label>
                            <input type="number" id="bot-maxPrice" step="0.01">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px">
                        <div class="form-group">
                            <label style="color:var(--success)">Auto Take-Profit (%)</label>
                            <input type="number" id="bot-tpPercent" step="1">
                        </div>
                        <div class="form-group">
                            <label style="color:var(--danger)">Auto Stop-Loss (%)</label>
                            <input type="number" id="bot-slPercent" step="1">
                        </div>
                    </div>
                    <div class="form-group" style="margin-top: 16px">
                        <label style="color:var(--danger)">🛑 Balance SL ($) - Kill Switch</label>
                        <input type="number" id="bot-balanceSl" step="1">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px">
                        <div class="form-group">
                            <label>Trade Min ($)</label>
                            <input type="number" id="bot-minTrade" step="1">
                        </div>
                        <div class="form-group">
                            <label>Trade Max ($)</label>
                            <input type="number" id="bot-maxTrade" step="1">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px">
                        <div class="form-group">
                            <label>Max Por Mercado ($)</label>
                            <input type="number" id="bot-maxPerMarket" step="1">
                        </div>
                        <div class="form-group">
                            <label>Max Por Token ($)</label>
                            <input type="number" id="bot-maxPerToken" step="1">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px">
                        <div class="form-group">
                            <label>Limite Geral de Gasto ($)</label>
                            <input type="number" id="bot-totalSpendLimit" step="1">
                        </div>
                        <div class="form-group">
                            <label>Volume Máximo em Aberto ($)</label>
                            <input type="number" id="bot-maxExposure" step="1">
                        </div>
                    </div>
                    <button class="btn" style="margin-top: 40px; width: 100%" onclick="updateBotConfig()">SALVAR ALTERAÇÕES</button>
                </div>
            </div>
        </div>

            <!-- Keep these inside tab-config -->
            <div class="card" style="margin-top: 24px">
            <h3 style="margin-bottom: 24px; display: flex; align-items: center; gap: 8px"><span>⚡</span> Filtros Avançados & Anti-Scam (Fase 5)</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px">
                <div class="form-group">
                    <label>Sniper Mode (Segundos) <span style="font-size:0.7em;color:var(--text-dim)">(0 = Desativado)</span></label>
                    <input type="number" id="bot-sniperModeSec" step="1" placeholder="Ex: 60">
                    <small style="color:var(--text-dim); display:block; margin-top:4px">Só copia trades feitos nos primeiros X segs. do mercado.</small>
                </div>
                <div class="form-group">
                    <label>Last-Minute Mode (Segundos) <span style="font-size:0.7em;color:var(--text-dim)">(0 = Desativado)</span></label>
                    <input type="number" id="bot-lastMinuteModeSec" step="1" placeholder="Ex: 60">
                    <small style="color:var(--text-dim); display:block; margin-top:4px">Só copia trades se o mercado fechar em menos de X segs.</small>
                </div>
                <div class="form-group">
                    <label>Máximo de Mercados Simultâneos <span style="font-size:0.7em;color:var(--text-dim)">(0 = Infinito)</span></label>
                    <input type="number" id="bot-maxMarketCount" step="1" placeholder="Ex: 10">
                    <small style="color:var(--text-dim); display:block; margin-top:4px">Bloqueia trades caso você já esteja em posições de muitos mercados.</small>
                </div>
                <div class="form-group">
                    <label>Liquidez Mínima do Mercado ($USD) <span style="font-size:0.7em;color:var(--text-dim)">(0 = Zero)</span></label>
                    <input type="number" id="bot-minMarketLiquidity" step="1" placeholder="Ex: 10000">
                    <small style="color:var(--text-dim); display:block; margin-top:4px">Filtro Anti-Scam. Rejeita mercados "rasos" e arriscados.</small>
                </div>
            </div>
        </div>

        <div class="card" style="margin-top: 24px">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px">
                <h3 style="display: flex; align-items: center; gap: 8px; margin: 0"><span>💰</span> Gestão da Carteira</h3>
                <div style="text-align: right">
                    <div style="font-size: 0.6rem; color: var(--text-dim); margin-bottom: 4px">CARTEIRA OPERACIONAL</div>
                    <div id="user-wallet-addr" style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--accent); background: rgba(var(--accent-rgb), 0.05); padding: 5px 12px; border-radius: 4px; border: 1px solid rgba(var(--accent-rgb), 0.1)">0x...</div>
                </div>
            </div>
            <div id="wallet-active-warning" style="background: rgba(245, 158, 11, 0.1); color: var(--warning); padding: 12px; border-radius: 6px; font-size: 0.85rem; margin-bottom: 20px; display: none">
                ⚠️ <strong>Robô em Operação:</strong> Você precisa desativar o robô no dashboard principal para alterar a carteira.
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px">
                <div>
                    <p style="font-size: 0.9rem; color: var(--text-dim); margin-bottom: 15px">Configuração de Carteiras:</p>
                    <div class="form-group">
                        <label>Chave Privada (0x...)</label>
                        <input type="password" id="settings-import-pk" placeholder="0x...">
                    </div>
                    <div class="form-group" style="margin-top: 16px">
                        <label>Proxy Wallet Address (Gnosis Safe)</label>
                        <input type="text" id="bot-proxyAddress" placeholder="0x... (Opcional se auto-detectado)">
                        <small style="color:var(--text-dim); display:block; margin-top:4px">Insira manualmente se o saldo não estiver aparecendo.</small>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px">
                        <button id="btn-import-settings" class="btn btn-outline btn-sm" onclick="importWalletSettings(this)">Atualizar Chave Privada</button>
                    </div>
                </div>
                <div style="border-left: 1px solid var(--border); padding-left: 24px">
                    <p style="font-size: 0.9rem; color: var(--text-dim); margin-bottom: 15px">Ou gerar um novo endereço exclusivo:</p>
                    <button id="btn-generate-settings" class="btn btn-sm" onclick="generateWalletSettings(this)">Gerar Nova Carteira</button>
                    <small style="display:block; margin-top:10px; color:var(--text-dim)">Atenção: A carteira antiga será substituída no sistema.</small>
                </div>
            </div>
        </div>
    </div>
  </main>

  <div id="message-banner"></div>

<script>
    let currentUser = null;
    let currentTab = 'bot';

    function switchTab(tab) {
        if (currentUser && currentUser.step !== 'ready' && tab !== 'bot') return;
        currentTab = tab;
        document.querySelectorAll('.tab-view').forEach(v => v.style.display = 'none');
        const target = document.getElementById('tab-' + tab);
        if (target) target.style.display = 'block';
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        const navTarget = document.getElementById('nav-' + tab);
        if (navTarget) navTarget.classList.add('active');
    }

    function copyToClipboard(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = btn.textContent;
            btn.textContent = 'COPIADO!';
            btn.style.color = 'var(--success)';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.color = 'var(--accent)';
            }, 2000);
        });
    }

    async function loadUser() {
        try {
            const res = await fetch('/api/user/me');
            if (res.status === 401) { window.location.href = '/login'; return; }
            if (!res.ok) throw new Error();
            currentUser = await res.json();
            renderDashboard();
        } catch (e) { console.error('LoadUser error:', e); }
    }

    function renderDashboard() {
        if (!currentUser) return;
        
        // Sync wallet address globally as soon as data is available
        const walletAddr = document.getElementById('user-wallet-addr');
        if (walletAddr) walletAddr.textContent = currentUser.wallet?.address || '---';

        const hasWallet = currentUser.wallet?.address?.length > 20;
        const hasTrader = currentUser.config?.traderAddress?.length > 20;
        const isMirrorMode = currentUser.config?.mode === 'MIRROR_100';
        const isReady = currentUser.step === 'ready';

        if (!hasWallet || (!hasTrader && !isMirrorMode && !isReady)) {
            document.getElementById('setup-wizard').style.display = 'block';
            document.querySelectorAll('.tab-view').forEach(v => v.style.display = 'none');
            document.querySelectorAll('.nav-item').forEach(i => {
                if (i.id !== 'nav-bot') i.classList.add('disabled');
            });
            
            if (!hasWallet) renderStep1();
            else if (!hasTrader && !isMirrorMode) renderStep2();
            else renderStep3();
        } else {
            document.getElementById('setup-wizard').style.display = 'none';
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('disabled'));
            switchTab(currentTab);
            renderMainDashboard();
        }
    }

    function renderStep1() {
        document.querySelectorAll('.step').forEach(s => s.className = 'step');
        document.getElementById('s1').className = 'step active';
        document.getElementById('wizard-title').textContent = 'Passo 1: Sua Carteira';
        document.getElementById('step-content').innerHTML = \`
            <p style="margin-bottom:20px; color:var(--text-dim); line-height:1.5">A plataforma utiliza uma carteira exclusiva para voc\u00EA. Gere uma nova ou importe uma existente via Chave Privada.</p>
            <button class="btn" onclick="generateWallet(this)" style="margin-bottom:12px">Gerar Nova Carteira</button>
            <div style="margin: 20px 0; display:flex; align-items:center; gap:10px; color:var(--border)">
                <div style="flex:1; height:1px; background:var(--border)"></div>
                <span style="font-size:0.7rem; font-weight:700">OU IMPORTAR</span>
                <div style="flex:1; height:1px; background:var(--border)"></div>
            </div>
            <div class="form-group">
                <label style="font-size:0.75rem; color:var(--text-dim)">Private Key</label>
                <input type="password" id="import-pk" placeholder="Chave Privada (0x...)">
                <small style="display:block; margin-top:4px; color:var(--text-dim); font-size:0.7rem">64 hex characters (with or without 0x prefix). Stored locally — NEVER sent to us or anyone else.</small>
            </div>
            <div style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); border-radius:8px; padding:12px; margin-bottom:16px; font-size:0.78rem; color:var(--warning)">
                ⚠️ <strong>Security:</strong> Your private key is stored locally in <code>.env</code> and never transmitted to us. Use a dedicated trading wallet — not your main wallet.
            </div>
            <button class="btn btn-outline" onclick="importWallet(this)">Validate</button>
            <div id="import-wallet-preview" style="margin-top:8px"></div>
        \`;
    }

    async function generateWallet(btn) {
        btn.disabled = true; btn.textContent = 'Gerando...';
        try {
            const res = await fetch('/api/user/generate-wallet', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                document.getElementById('step-content').innerHTML = \`
                    <div style="background:rgba(16,185,129,0.05); border:1px solid var(--success); padding:24px; border-radius:16px; margin-bottom:24px; animation:fadeIn 0.3s ease">
                        <h4 style="color:var(--success); margin-bottom:16px">\u2705 Carteira Gerada com Sucesso!</h4>
                        <p style="font-size:0.85rem; color:var(--text-dim); margin-bottom:12px">Esta \u00E9 a sua chave secreta. **Guarde-a com cuidado**, voc\u00EA precisar\u00E1 dela para acessar sua conta na Polymarket.</p>
                        
                        <div style="background:var(--bg); padding:16px; border-radius:8px; border:1px solid var(--border); font-family:var(--font-mono); font-size:0.8rem; margin-bottom:16px; position:relative">
                            <div style="color:var(--text-dim); font-size:0.6rem; margin-bottom:4px">CHAVE PRIVADA</div>
                            <div style="color:var(--accent); word-break:break-all" id="generated-pk">\${data.privateKey}</div>
                            <button onclick="copyToClipboard('\${data.privateKey}', this)" style="position:absolute; top:12px; right:12px; background:transparent; border:none; color:var(--accent); cursor:pointer; font-size:0.7rem; font-weight:700">COPIAR</button>
                        </div>

                        <div style="background:rgba(59,130,246,0.1); border:1px solid #3b82f6; padding:16px; border-radius:12px; margin-bottom:20px">
                            <h5 style="color:#3b82f6; margin-bottom:8px; font-size:0.85rem">\uD83D\uDD17 Como Vincular na Polymarket:</h5>
                            <ol style="font-size:0.75rem; color:var(--text-dim); padding-left:18px; line-height:1.4; margin-bottom:12px">
                                <li>Copie sua <b>Chave Privada</b> acima.</li>
                                <li>No seu navegador, abra sua <b>MetaMask</b> e escolha "Importar Conta".</li>
                                <li>Cole a chave e clique em "Importar".</li>
                                <li>Abra a Polymarket e clique em <b>"Conectar Carteira"</b>.</li>
                            </ol>
                            <button onclick="window.open('https://polymarket.com', '_blank')" style="width:100%; padding:10px; background:#3b82f6; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:700; font-size:0.75rem">ABRIR POLYMARKET AGORA</button>
                        </div>

                        <p style="font-size:0.75rem; color:var(--danger); font-weight:700; margin-bottom:20px">\u26A0\uFE0F AVISO: Se voc\u00EA perder esta chave, perder\u00E1 o acesso definitivo aos seus fundos.</p>
                        
                        <button class="btn" onclick="loadUser()">J\u00C1 SALVEI EM LOCAL SEGURO, PROSSEGUIR</button>
                    </div>
                \`;
            } else {
                showBanner(data.error || 'Erro ao gerar carteira', 'danger');
                btn.disabled = false; btn.textContent = 'Gerar Nova Carteira';
            }
        } catch (e) {
            showBanner('Erro de conex\u00E3o', 'danger');
            btn.disabled = false; btn.textContent = 'Gerar Nova Carteira';
        }
    }

    async function importWallet(btn) {
        const pkInput = document.getElementById('import-pk');
        const pk = pkInput.value.trim();
        if (!pk) return showBanner('Informe a Chave Privada', 'warning');
        
        btn.disabled = true; 
        const originalText = btn.textContent;
        btn.textContent = 'Validando...';
        
        try {
            // Step 1: Preview the wallet info without saving
            const previewRes = await fetch('/api/user/validate-wallet-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ privateKey: pk })
            });
            const preview = await previewRes.json();
            
            if (!previewRes.ok) {
                showBanner(preview.error || 'Chave Privada Inválida', 'danger');
                btn.disabled = false;
                btn.textContent = originalText;
                return;
            }

            // Step 2: Build the wallet info card with string concatenation (safe inside TS template literal)
            const safeProxy = preview.proxyWallet || preview.address;
            const safeBal = '$' + Number(preview.onchainBalance || 0).toFixed(2);
            const safePos = String(preview.openPositions);
            const infoCard = '<div style="background:rgba(16,185,129,0.05); border:1px solid var(--success); border-radius:12px; padding:20px; margin-top:16px; animation:fadeIn 0.3s ease">'
                + '<table style="width:100%; font-size:0.82rem; border-collapse:collapse">'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Wallet Type:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + preview.walletType + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Your Address (EOA):</td><td style="padding:8px 0 8px 12px; font-family:var(--font-mono); font-size:0.72rem; color:var(--accent); word-break:break-all">' + preview.address + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Polymarket Wallet:</td><td style="padding:8px 0 8px 12px; font-family:var(--font-mono); font-size:0.72rem; color:var(--text-dim); word-break:break-all">' + safeProxy + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim)">On-chain USDC:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + safeBal + '</td></tr>'
                + '<tr><td style="padding:8px 0; color:var(--text-dim)">Open Positions:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + safePos + '</td></tr>'
                + '</table>'
                + '<div style="margin-top:16px; background:rgba(16,185,129,0.1); border-radius:6px; padding:10px 14px; font-size:0.8rem; color:var(--success); display:flex; align-items:center; gap:8px"><span>✅</span> <strong>Key validated successfully.</strong> Click Continue to proceed.</div>'
                + '<button class="btn" style="margin-top:16px; width:100%" onclick="confirmImportWallet(&quot;' + pk + '&quot;)">Continuar →</button>'
                + '</div>';
            const previewEl = document.getElementById('import-wallet-preview');
            if (previewEl) previewEl.innerHTML = infoCard;

        } catch (e) {
            console.error('Validate error:', e);
            showBanner('Erro de conexão com o servidor', 'danger');
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    async function confirmImportWallet(pk) {
        try {
            const res = await fetch('/api/user/import-wallet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ privateKey: pk })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                showBanner('Carteira Importada com Sucesso!', 'success');
                setTimeout(() => loadUser(), 800);
            } else {
                showBanner(data.error || 'Erro ao importar carteira', 'danger');
            }
        } catch (e) {
            showBanner('Erro de conexão com o servidor', 'danger');
        }
    }

    function renderStep2() {
        document.querySelectorAll('.step').forEach(s => s.className = 'step');
        document.getElementById('s1').className = 'step done';
        document.getElementById('s2').className = 'step active';
        document.getElementById('wizard-title').textContent = 'Passo 2: Trader Alvo';
        document.getElementById('step-content').innerHTML = \`
            <p style="margin-bottom:20px; color:var(--text-dim); line-height:1.5">Informe o endereço do trader que deseja copiar. O bot monitorará cada aposta dele no Polymarket.</p>
            <div class="form-group">
                <label>Endereço da Carteira (Polymarket)</label>
                <input type="text" id="setup-trader" placeholder="0x..." value="\${currentUser.config?.traderAddress || ''}">
            </div>
            <button class="btn" onclick="nextToStep3(this)">Próximo Passo: Estratégia</button>
            <div style="margin: 15px 0; display:flex; align-items:center; gap:10px; color:var(--border)">
                <div style="flex:1; height:1px; background:var(--border)"></div>
                <span style="font-size:0.7rem; font-weight:700">MODO MIRROR</span>
                <div style="flex:1; height:1px; background:var(--border)"></div>
            </div>
            <button class="btn btn-outline" onclick="enterMirrorMode(this)">Usar Mirror 100% (Sem Filtros)</button>
            <p style="margin-top:10px; font-size:0.75rem; color:var(--text-dim); text-align:center">Copia exatamente cada trade do alvo, ignorando limites de preço e tamanho.</p>
        \`;
    }

    async function enterMirrorMode(btn) {
        const addr = document.getElementById('setup-trader').value;
        if (!addr || addr.length < 40) return showBanner('Informe o Trader para Espelhar', 'warning');
        btn.disabled = true; btn.textContent = 'Configurando...';
        try {
            await fetch('/api/user/update-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    traderAddress: addr, 
                    mode: 'MIRROR_100', 
                    strategy: 'PERCENTAGE', 
                    copySize: 100, 
                    enabled: true, 
                    finalize: true 
                })
            });
            loadUser();
        } catch (e) {
            showBanner('Erro ao configurar Mirror', 'danger');
            btn.disabled = false;
        }
    }

    async function nextToStep3(btn) {
        const addr = document.getElementById('setup-trader').value;
        if (!addr || addr.length < 40) return showBanner('Endereço Inválido', 'warning');
        btn.disabled = true; btn.textContent = 'Salvando...';
        await fetch('/api/user/update-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ traderAddress: addr, finalize: false })
        });
        loadUser();
    }

    function renderStep3() {
        document.querySelectorAll('.step').forEach(s => s.className = 'step');
        document.getElementById('s1').className = 'step done';
        document.getElementById('s2').className = 'step done';
        document.getElementById('s3').className = 'step active';
        document.getElementById('wizard-title').textContent = 'Passo 3: Sua Estrat\u00E9gia';
        document.getElementById('step-content').innerHTML = \`
            <p style="margin-bottom:20px; color:var(--text-dim); line-height:1.5">Como voc\u00EA deseja copiar os trades? Defina o valor inicial da opera\u00E7\u00E3o.</p>
            
            <div class="form-group">
                <label>Estrat\u00E9gia</label>
                <select id="setup-strategy">
                    <option value="PERCENTAGE">C\u00F3pia Proporcional (%)</option>
                    <option value="FIXED">Valor Fixo (USD)</option>
                </select>
            </div>
            
            <div class="form-group">
                <label>Tamanho da C\u00F3pia (Valor ou %)</label>
                <input type="number" id="setup-size" value="10" step="0.1">
                <small style="color:var(--text-dim)">Ex: 10% do trader ou 10 USD fixos.</small>
            </div>

            <div class="form-group">
                <label>Volume M\u00E1ximo em Aberto (Total USD)</label>
                <input type="number" id="setup-maxExposure" value="500" step="1">
                <small style="color:var(--text-dim)">O bot parar\u00E1 de negociar se seu volume total em posi\u00E7\u00F5es passar disso.</small>
            </div>

            <div style="background: rgba(var(--accent-rgb), 0.1); padding: 15px; border-radius: 8px; margin-bottom: 24px">
                <p style="font-size: 0.85rem; line-height: 1.4; color: var(--accent)">
                    \uD83D\uDCA1 Voc\u00EA poder\u00E1 alterar essas e outras configura\u00E7\u00F5es avan\u00E7adas (Slippage, Filtros, TP/SL) a qualquer momento no seu Painel de Controle.
                </p>
            </div>

            <button class="btn" onclick="finalizeSetup(this)">Finalizar e Iniciar Bot</button>
        \`;
    }

    async function finalizeSetup(btn) {
        const strategy = document.getElementById('setup-strategy').value;
        const size = parseFloat(document.getElementById('setup-size').value);
        const maxExposure = parseFloat(document.getElementById('setup-maxExposure').value);
        
        if (isNaN(size) || size <= 0) return showBanner('Valor Inv\u00E1lido', 'warning');
        
        btn.disabled = true; btn.textContent = 'Iniciando Opera\u00E7\u00E3o...';
        await fetch('/api/user/update-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy, copySize: size, maxExposure, enabled: true, finalize: true })
        });
        loadUser();
    }

    function renderMainDashboard() {
        try {
            const c = currentUser.config || {};
            const walletAddr = document.getElementById('user-wallet-addr');
            if (walletAddr) walletAddr.textContent = currentUser.wallet?.address || '---';
            
            const addrDisplay = document.getElementById('trader-addr-display');
            const isArbitrage = c.mode === 'ARBITRAGE';
            
            if (addrDisplay) {
                if (isArbitrage) {
                    addrDisplay.textContent = 'MODO ARBITRAGE ATIVO';
                    addrDisplay.style.color = 'var(--warning)';
                } else {
                    addrDisplay.textContent = c.traderAddress ? c.traderAddress.slice(0,12) + '...' + c.traderAddress.slice(-4) : 'Nenhum';
                    addrDisplay.style.color = 'var(--accent)';
                }
            }
            
            // Status UI
            const statusText = document.getElementById('bot-status-text');
            const masterBtn = document.getElementById('bot-master-btn');
            if (statusText) {
                statusText.textContent = c.enabled ? 'ATIVO' : 'PAUSADO';
                statusText.className = c.enabled ? 'status-active' : 'status-paused';
            }
            if (masterBtn) {
                masterBtn.textContent = c.enabled ? 'DESATIVAR' : 'ATIVAR AGORA';
                masterBtn.style.background = c.enabled ? 'var(--danger)' : 'var(--success)';
            }

            // Config Fill
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
            setVal('bot-trader', c.traderAddress || '');
            const tName = document.getElementById('trader-name');
            if (tName) tName.textContent = c.traderAddress ? (c.traderAddress.slice(0,10) + '...') : 'Nenhum';
            setVal('bot-strategy', c.strategy || 'PERCENTAGE');
            setVal('bot-size', c.copySize || 10);
            setVal('bot-maxExposure', c.maxExposure || 500);
            setVal('bot-orderType', c.orderType || 'MARKET');
            setVal('bot-slippageBuy', c.slippageBuy || 0.05);
            setVal('bot-slippageSell', c.slippageSell || 0.05);
            setVal('bot-tpPercent', c.tpPercent || 0);
            setVal('bot-slPercent', c.slPercent || 0);
            setVal('bot-minPrice', c.minPrice || 0);
            setVal('bot-maxPrice', c.maxPrice || 1.0);
            setVal('bot-minTrade', c.minTradeSize || 0);
            setVal('bot-maxTrade', c.maxTradeSize || 1000);
            setVal('bot-maxPerMarket', c.maxPerMarket || 100);
            setVal('bot-maxPerToken', c.maxPerToken || 50);
            setVal('bot-totalSpendLimit', c.totalSpendLimit || 0);
            setVal('bot-sniperModeSec', c.sniperModeSec || 0);
            setVal('bot-lastMinuteModeSec', c.lastMinuteModeSec || 0);
            setVal('bot-maxMarketCount', c.maxMarketCount || 0);
            setVal('bot-minMarketLiquidity', c.minMarketLiquidity || 0);
            setVal('bot-balanceSl', c.balanceSl || 0);
            setVal('bot-triggerDelta', c.triggerDelta || 0.005);
            setVal('bot-hedgeCeiling', c.hedgeCeiling || 0.95);
            setVal('bot-mode', c.mode || 'COPY');
            setVal('bot-proxyAddress', currentUser.wallet?.proxyAddress || '');
            
            const botBuyAtMin = document.getElementById('bot-buyAtMin');
            if (botBuyAtMin) botBuyAtMin.checked = !!c.buyAtMin;
            const botRev = document.getElementById('bot-reverse');
            if (botRev) botRev.checked = !!c.reverseCopy;
            const botBuy = document.getElementById('bot-copyBuy');
            if (botBuy) botBuy.checked = c.copyBuy !== false;
            const botSell = document.getElementById('bot-copySell');
            if (botSell) botSell.checked = c.copySell !== false;

            // Wallet management safety UI
            const isBotActive = !!c.enabled;
            const warning = document.getElementById('wallet-active-warning');
            const btnImport = document.getElementById('btn-import-settings');
            const btnGenerate = document.getElementById('btn-generate-settings');
            const inputPk = document.getElementById('settings-import-pk');

            if (warning) warning.style.display = isBotActive ? 'block' : 'none';
            if (btnImport) btnImport.disabled = isBotActive;
            if (btnGenerate) btnGenerate.disabled = isBotActive;
            if (inputPk) inputPk.disabled = isBotActive;

            refreshTrades();
            refreshStats();
        } catch (err) { console.error('Render dashboard crash:', err); }
    }

    async function importWalletSettings(btn) {
        const pkInput = document.getElementById('settings-import-pk');
        const proxyInput = document.getElementById('bot-proxyAddress');
        const pk = pkInput.value.trim();
        const proxyAddress = proxyInput ? proxyInput.value.trim() : '';
        if (!pk) return showBanner('Chave Privada Necessária', 'warning');
        
        btn.disabled = true; 
        const originalText = btn.textContent;
        btn.textContent = 'Validando...';
        
        try {
            const previewRes = await fetch('/api/user/validate-wallet-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ privateKey: pk, proxyAddress })
            });
            const preview = await previewRes.json();
            
            if (!previewRes.ok) {
                showBanner(preview.error || 'Chave Privada Inválida', 'danger');
                btn.disabled = false;
                btn.textContent = originalText;
                return;
            }

            const safeProxy = preview.proxyWallet || preview.address;
            const safeBal = '$' + Number(preview.onchainBalance || 0).toFixed(2);
            const safePos = String(preview.openPositions);
            const infoCard = '<div style="background:rgba(16,185,129,0.05); border:1px solid var(--success); border-radius:12px; padding:20px; margin-top:16px; animation:fadeIn 0.3s ease">'
                + '<table style="width:100%; font-size:0.82rem; border-collapse:collapse">'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Wallet Type:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + preview.walletType + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Your Address (EOA):</td><td style="padding:8px 0 8px 12px; font-family:var(--font-mono); font-size:0.72rem; color:var(--accent); word-break:break-all">' + preview.address + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim); white-space:nowrap">Polymarket Wallet:</td><td style="padding:8px 0 8px 12px; font-family:var(--font-mono); font-size:0.72rem; color:var(--text-dim); word-break:break-all">' + safeProxy + '</td></tr>'
                + '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0; color:var(--text-dim)">On-chain USDC:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + safeBal + '</td></tr>'
                + '<tr><td style="padding:8px 0; color:var(--text-dim)">Open Positions:</td><td style="padding:8px 0 8px 12px; color:var(--text); font-weight:600">' + safePos + '</td></tr>'
                + '</table>'
                + '<div style="margin-top:16px; background:rgba(16,185,129,0.1); border-radius:6px; padding:10px 14px; font-size:0.8rem; color:var(--success); display:flex; align-items:center; gap:8px"><span>✅</span> <strong>Validação bem-sucedida.</strong> Confirme para atualizar.</div>'
                + '<button class="btn" style="margin-top:16px; width:100%" onclick="confirmImportWalletSettings(&quot;' + pk + '&quot;, &quot;' + proxyAddress + '&quot;)">Confirmar Atualização →</button>'
                + '</div>';
            
            let previewContainer = document.getElementById('settings-import-preview');
            if (!previewContainer) {
                previewContainer = document.createElement('div');
                previewContainer.id = 'settings-import-preview';
                btn.parentNode.parentNode.appendChild(previewContainer);
            }
            previewContainer.innerHTML = infoCard;

        } catch (e) {
            console.error('Validate error:', e);
            showBanner('Erro de conexão com o servidor', 'danger');
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    async function confirmImportWalletSettings(pk, proxyAddress) {
        const btn = document.getElementById('btn-import-settings');
        if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }
        try {
            const res = await fetch('/api/user/import-wallet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ privateKey: pk, proxyAddress })
            });
            const data = await res.json();
            if (btn) { btn.disabled = false; btn.textContent = 'Atualizar Chave Privada'; }
            if (res.ok) { 
                showBanner('Carteira Atualizada com Sucesso!', 'success'); 
                const previewContainer = document.getElementById('settings-import-preview');
                if (previewContainer) previewContainer.innerHTML = '';
                document.getElementById('settings-import-pk').value = '';
                setTimeout(() => loadUser(), 800);
            }
            else { showBanner(data.error || 'Falha ao importar', 'danger'); }
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Atualizar Chave Privada'; }
            showBanner('Erro de conexão com o servidor', 'danger');
        }
    }

    async function generateWalletSettings(btn) {
        if (!confirm('Deseja gerar uma NOVA carteira? A atual ser\u00E1 substit\u00EDda no sistema.')) return;
        btn.disabled = true; btn.textContent = 'Gerando...';
        try {
            const res = await fetch('/api/user/generate-wallet', { method: 'POST' });
            const data = await res.json();
            btn.disabled = false; btn.textContent = 'Gerar Nova Carteira';
            if (res.ok && data.success) {
                document.getElementById('tab-config').innerHTML = \`
                    <div style="max-width:600px; margin:0 auto; background:rgba(16,185,129,0.05); border:1px solid var(--success); padding:32px; border-radius:16px; animation:fadeIn 0.3s ease">
                        <h3 style="color:var(--success); margin-bottom:20px">\u2705 Nova Carteira Criada!</h3>
                        <p style="color:var(--text-dim); margin-bottom:20px">Sua carteira anterior foi substitu\u00EDda. Salve os dados abaixo imediatamente.</p>
                        
                        <div style="background:var(--bg); padding:16px; border-radius:8px; border:1px solid var(--border); font-family:var(--font-mono); font-size:0.8rem; margin-bottom:20px">
                            <div style="color:var(--text-dim); font-size:0.6rem; margin-bottom:4px">ENDERE\u00C7O</div>
                            <div style="word-break:break-all">\${data.address}</div>
                        </div>

                        <div style="background:var(--bg); padding:16px; border-radius:8px; border:1px solid var(--border); font-family:var(--font-mono); font-size:0.8rem; margin-bottom:24px; position:relative">
                            <div style="color:var(--text-dim); font-size:0.6rem; margin-bottom:4px">CHAVE PRIVADA (CONSERVAR!)</div>
                            <div style="color:var(--accent); word-break:break-all">\${data.privateKey}</div>
                            <button onclick="copyToClipboard('\${data.privateKey}', this)" style="position:absolute; top:12px; right:12px; background:transparent; border:none; color:var(--accent); cursor:pointer; font-size:0.7rem; font-weight:700">COPIAR</button>
                        </div>

                        <div style="background:rgba(59,130,246,0.1); border:1px solid #3b82f6; padding:20px; border-radius:12px; margin-bottom:24px">
                             <h4 style="color:#3b82f6; margin-bottom:12px; font-size:0.9rem">\uD83D\uDD17 Instru\u00E7\u00F5es de V\u00EDnculo:</h4>
                             <ul style="font-size:0.75rem; color:var(--text-dim); padding-left:18px; line-height:1.6">
                                <li>Importe esta <b>Chave Privada</b> no seu MetaMask.</li>
                                <li>Conecte sua MetaMask no site da Polymarket.</li>
                             </ul>
                             <button onclick="window.open('https://polymarket.com', '_blank')" style="margin-top:12px; width:100%; padding:12px; background:#3b82f6; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:700">ABRIR POLYMARKET</button>
                        </div>

                        <button class="btn" style="width:100%" onclick="loadUser(); switchTab('config')">CONCLU\u00CDDO</button>
                    </div>
                \`;
            } else {
                showBanner(data.error || 'Falha ao gerar', 'danger');
            }
        } catch (e) {
            showBanner('Erro de conex\u00E3o', 'danger');
            btn.disabled = false;
        }
    }

    async function refreshStats() {
        try {
            const res = await fetch('/api/user/stats');
            const data = await res.json();
            const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
            setTxt('stat-balance', '$' + Number(data.balance || 0).toFixed(2));
            setTxt('stat-exposure', '$' + Number(data.exposure || 0).toFixed(2));
            
            if (data.proxy) {
                const pInput = document.getElementById('bot-proxyAddress');
                if (pInput && !pInput.value) {
                    pInput.placeholder = data.proxy + ' (Auto-Detectado)';
                }
            }

            if (currentUser.config?.traderAddress) {
                const addr = currentUser.config.traderAddress;
                setTxt('stat-trader', addr.slice(0,6) + '...' + addr.slice(-4));
            }
        } catch (e) { console.error('Stats refresh fail:', e); }
    }

    async function refreshTrades() {
        try {
            const res = await fetch('/api/user/trades');
            if (!res.ok) return;
            const trades = await res.json();
            const tbody = document.getElementById('user-trade-body');
            if (!tbody) return;

            if (!trades || trades.length === 0) {
                tbody.innerHTML = \`<tr><td colspan="10" style="text-align:center; padding:30px; color:var(--text-dim)">🔍 Monitorando... Nenhuma oportunidade detectada ainda.</td></tr>\`;
                return;
            }

            tbody.innerHTML = trades.map(t => {
                const status = t.executionStatus || 'DETECTADO';

                // Status styling
                const statusStyles = {
                    'SUCESSO':    { bg: 'rgba(16,185,129,0.15)', color: 'var(--success)', icon: '\u2705' },
                    'DETECTADO':  { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa',        icon: '\u26A1' },
                    'PULADO (SALDO)': { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: '\uD83D\uDCB8' },
                    'PULADO (EXPOSIÇÃO)': { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: '\uD83D\uDCCA' },
                    'PULADO (SLIPPAGE)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '\u26A0\uFE0F' },
                    'PULADO (TAMANHO)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '\uD83D\uDCCF' },
                    'PULADO (LADO)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '\uD83D\uDEAB' },
                    'PULADO (PREÇO)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '\uD83D\uDCB2' },
                    'PULADO (ESTRATÉGIA)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '\uD83D\uDCE9' },
                    'PULADO (LIQUIDEZ)': { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: '💧' },
                    'ERRO (SALDO)': { bg: 'rgba(239,68,68,0.15)', color: 'var(--danger)', icon: '❌' },
                    'ERRO (API)':   { bg: 'rgba(239,68,68,0.15)', color: 'var(--danger)', icon: '🔴' }
                };
                const style = statusStyles[status] || { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)', icon: '\uD83D\uDD35' };

                // P&L styling
                let pnlHtml = '<span style="color:var(--text-dim)">\\u2014</span>';
                if (t.pnlPercent !== null && t.pnlPercent !== undefined) {
                    const pnlColor = t.pnlPercent >= 0 ? 'var(--success)' : 'var(--danger)';
                    const pnlIcon = t.pnlPercent >= 0 ? '\\u2197\\uFE0F' : '\\u2198\\uFE0F';
                    pnlHtml = \`<span style="color:\${pnlColor}; font-weight:700">\${pnlIcon} \${t.pnlLabel}</span>\`;
                }

                // Entry price
                const entryPrice = t.price ? \`\${(parseFloat(t.price)*100).toFixed(1)}\\u00A2\` : '\\u2014';
                const curPrice = t.curPrice !== null ? \`\${(t.curPrice*100).toFixed(1)}\\u00A2\` : '\\u2014';

                // Chain vs API detection badge
                const sourceBadge = t.isChainDetected
                    ? \`<span style="font-size:0.6rem; background:rgba(59,130,246,0.2); color:#60a5fa; padding:1px 5px; border-radius:3px; margin-left:4px">⚡ON-CHAIN</span>\`
                    : '';

                // Market link
                const marketLink = t.slug
                    ? \`<a href="https://polymarket.com/event/\${t.eventSlug || t.slug}" target="_blank" style="color:var(--accent); font-size:0.85rem" title="\${t.title}">\${(t.title || t.slug).slice(0,35)}...\${sourceBadge}</a>\`
                    : \`<span style="font-size:0.85rem">\${(t.title || 'Detectando...').slice(0,35)}\${sourceBadge}</span>\`;

                const tooltipContent = [
                    status,
                    t.executionDetails ? \`Detalhes: \${t.executionDetails}\` : '',
                    t.myEntryAmount ? \`Entrada: $\${t.myEntryAmount.toFixed(2)}\` : '',
                    t.myEntryPrice ? \`Preço: \${(t.myEntryPrice*100).toFixed(1)}c\` : '',
                    t.myExecutedAt ? \`Hora: \${new Date(t.myExecutedAt).toLocaleTimeString()}\` : ''
                ].filter(Boolean).join(' | ');

                return \`
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.2s" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                    <td style="font-size:0.72rem; color:var(--text-dim); white-space:nowrap">\${new Date(t.timestamp).toLocaleString('pt-BR')}</td>
                    <td>\${marketLink}</td>
                    <td><span style="color:\${t.side==='BUY'?'var(--success)':'var(--danger)'}; font-weight:700">\${t.side==='BUY'?'📈 COMPRA':'📉 VENDA'}</span></td>
                    <td style="font-weight:700; color:#fff">$\${(t.usdcSize||0).toFixed(2)}</td>
                    <td style="font-family:var(--font-mono); font-size:0.8rem">\${entryPrice}</td>
                    <td style="font-family:var(--font-mono); font-size:0.8rem">\${curPrice}</td>
                    <td>\${pnlHtml}</td>
                    <td style="font-weight:700; color:#adf">\${t.myEntryAmount !== null && t.myEntryAmount !== undefined ? '$' + t.myEntryAmount.toFixed(2) : '<span style="color:var(--text-dim)">—</span>'}</td>
                    <td>\${t.myPnlUSD !== null && t.myPnlUSD !== undefined ? '<span style="color:' + (t.myPnlUSD >= 0 ? 'var(--success)' : 'var(--danger)') + '; font-weight:700">' + (t.myPnlUSD >= 0 ? '+' : '') + '$' + t.myPnlUSD.toFixed(2) + '</span>' : '<span style="color:var(--text-dim)">—</span>'}</td>
                    <td><span class="badge" title="\${tooltipContent}" style="background:\${style.bg}; color:\${style.color}; cursor:help">\${style.icon} \${status}</span></td>
                </tr>\`;
            }).join('');

            // Update Trader Info
            if (trades.length > 0) {
                const first = trades[0];
                const nameEl = document.getElementById('trader-name');
                if (nameEl) nameEl.textContent = first.pseudonym || first.name || (currentUser.config?.traderAddress ? currentUser.config.traderAddress.slice(0,10)+'...' : 'Nenhum');
                
                const avatarEl = document.getElementById('trader-avatar');
                if (avatarEl && first.profileImage) {
                    avatarEl.innerHTML = \`<img src="\${first.profileImage}" style="width:100%; height:100%; border-radius:50%; object-fit:cover">\`;
                }
            }
        } catch(e) { console.error('Trades refresh fail:', e); }
    }

    async function toggleBotMain() {
        try {
            const nextState = !(currentUser.config?.enabled);
            await fetch('/api/user/update-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: nextState })
            });
            loadUser();
        } catch (e) { console.error('Toggle bot fail:', e); }
    }

    async function updateBotConfig() {
        const config = {
            traderAddress: document.getElementById('bot-trader').value,
            strategy: document.getElementById('bot-strategy').value,
            copySize: parseFloat(document.getElementById('bot-size').value),
            maxExposure: parseFloat(document.getElementById('bot-maxExposure').value),
            orderType: document.getElementById('bot-orderType').value,
            slippageBuy: parseFloat(document.getElementById('bot-slippageBuy').value),
            slippageSell: parseFloat(document.getElementById('bot-slippageSell').value),
            tpPercent: parseFloat(document.getElementById('bot-tpPercent').value),
            slPercent: parseFloat(document.getElementById('bot-slPercent').value),
            balanceSl: parseFloat(document.getElementById('bot-balanceSl').value),
            minPrice: parseFloat(document.getElementById('bot-minPrice').value),
            maxPrice: parseFloat(document.getElementById('bot-maxPrice').value),
            minTradeSize: parseFloat(document.getElementById('bot-minTrade').value),
            maxTradeSize: parseFloat(document.getElementById('bot-maxTrade').value),
            maxPerMarket: parseFloat(document.getElementById('bot-maxPerMarket').value),
            maxPerToken: parseFloat(document.getElementById('bot-maxPerToken').value),
            totalSpendLimit: parseFloat(document.getElementById('bot-totalSpendLimit').value),
            buyAtMin: document.getElementById('bot-buyAtMin').checked,
            reverseCopy: document.getElementById('bot-reverse').checked,
            copyBuy: document.getElementById('bot-copyBuy').checked,
            copySell: document.getElementById('bot-copySell').checked,
            sniperModeSec: parseInt(document.getElementById('bot-sniperModeSec').value) || 0,
            lastMinuteModeSec: parseInt(document.getElementById('bot-lastMinuteModeSec').value) || 0,
            maxMarketCount: parseInt(document.getElementById('bot-maxMarketCount').value) || 0,
            minMarketLiquidity: parseFloat(document.getElementById('bot-minMarketLiquidity').value) || 0,
            mode: document.getElementById('bot-mode').value,
            proxyAddress: document.getElementById('bot-proxyAddress').value,
            triggerDelta: parseFloat(document.getElementById('bot-triggerDelta').value) || 0.005,
            hedgeCeiling: parseFloat(document.getElementById('bot-hedgeCeiling').value) || 0.95
        };
        const res = await fetch('/api/user/update-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (res.ok) { showBanner('ConfiguraÃ§Ãµes Salvas', 'success'); loadUser(); }
    }

    function showBanner(msg, type = 'success') {
        const b = document.getElementById('message-banner');
        b.textContent = msg.toUpperCase();
        b.style.background = type === 'success' ? 'var(--success)' : (type === 'warning' ? 'var(--warning)' : 'var(--danger)');
        b.style.display = 'block';
        setTimeout(() => b.style.display = 'none', 4000);
    }

    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }
    
    // Auto refresh stats e trades em tempo real
    setInterval(refreshStats, 5000);
    setInterval(refreshTrades, 5000);
    setInterval(refreshPositions, 15000);
    
    async function refreshPositions() {
        try {
            const res = await fetch('/api/user/positions');
            if (!res.ok) return;
            const positions = await res.json();
            const tbody = document.getElementById('user-positions-body');
            if (!tbody) return;

            if (!positions || positions.length === 0) {
                tbody.innerHTML = \`<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-dim)">Nenhuma posiÃ§Ã£o ativa encontrada no momento.</td></tr>\`;
                return;
            }

            tbody.innerHTML = positions.map(p => {
                const pnl = p.pnlPercent !== undefined ? p.pnlPercent : 0;
                const pnlColor = pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                const pnlIcon = pnl >= 0 ? 'â†‘' : 'â†“';
                
                const mktLink = \`<a href="https://polymarket.com/event/\${p.slug || ''}" target="_blank" style="color:var(--accent); font-size:0.85rem">\${(p.title || 'Mercado Desconhecido').slice(0, 45)}...</a>\`;

                return \`<tr>
                    <td>\${mktLink}</td>
                    <td><span style="font-weight:700">\${p.assetName || p.asset.slice(0,6)}</span></td>
                    <td style="font-family:var(--font-mono); font-size:0.85rem">\${(p.avgPrice * 100).toFixed(1)}Â¢</td>
                    <td style="font-family:var(--font-mono); font-size:0.85rem">\${(p.curPrice * 100).toFixed(1)}Â¢</td>
                    <td style="font-weight:700">\${p.size.toFixed(2)}</td>
                    <td style="font-weight:700; color:#fff">$\${p.currentValue.toFixed(2)}</td>
                    <td><span style="color:\${pnlColor}; font-weight:700">\${pnlIcon} \${(pnl>=0?'+':'')}\${pnl.toFixed(2)}%</span></td>
                </tr>\`;
            }).join('');
        } catch(e) { console.error('Positions refresh fail:', e); }
    }

    loadUser();
  </script>
</body> </html>`;
// Enrichen AuthRequest with full User data for all /api/user/ routes
app.use('/api/user/', async (req, _res, next) => {
    if (req.user?.id) {
        req.fullUser = await User.findById(req.user.id).lean();
    }
    next();
});
app.get('/api/user/me', authenticateToken, async (req, res) => {
    const user = req.fullUser;
    res.json(user ? {
        id: user._id,
        chatId: user.chatId,
        username: user.username || user.chatId,
        role: user.role,
        wallet: user.wallet,
        config: user.config,
        step: user.step
    } : { error: 'Not logged in' });
});
app.post('/api/user/generate-wallet', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user?.id);
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        if (user.config?.enabled) {
            return res.status(400).json({ error: 'Desative o robÃ´ no dashboard antes de alterar a carteira' });
        }
        const newWallet = ethers.Wallet.createRandom();
        user.wallet = {
            address: newWallet.address,
            privateKey: newWallet.privateKey
        };
        // Only set to setup if not already ready (to allow seamless swaps)
        if (user.step !== 'ready')
            user.step = 'setup';
        await user.save();
        console.log(`[WALLET] Generated new wallet for ${user.username || user.chatId}: ${newWallet.address}`);
        res.json({ success: true, address: newWallet.address, privateKey: newWallet.privateKey });
    }
    catch (e) {
        console.error('[WALLET] Generation error:', e);
        res.status(500).json({ error: 'Failed to generate wallet' });
    }
});
// Preview endpoint: derives wallet info from PK without saving
app.post('/api/user/validate-wallet-preview', authenticateToken, async (req, res) => {
    try {
        let { privateKey, proxyAddress } = req.body;
        if (!privateKey)
            return res.status(400).json({ error: 'Private key required' });
        privateKey = privateKey.trim();
        if (!privateKey.startsWith('0x'))
            privateKey = '0x' + privateKey;
        if (privateKey.length !== 66)
            return res.status(400).json({ error: 'Chave privada inválida (deve ter 64 hex chars)' });
        if (proxyAddress)
            proxyAddress = proxyAddress.trim();
        if (proxyAddress && !proxyAddress.startsWith('0x'))
            proxyAddress = '0x' + proxyAddress;
        const wallet = new ethers.Wallet(privateKey);
        const eoaAddress = wallet.address;
        let detectedProxy = proxyAddress || null;
        let walletType = proxyAddress ? 'MetaMask (proxy manual)' : 'EOA';
        // Try to detect proxy wallet from Polymarket public-profile if not provided
        if (!detectedProxy) {
            try {
                const profile = await fetchData(`https://gamma-api.polymarket.com/public-profile?address=${eoaAddress}`);
                if (profile && profile.proxyWallet && profile.proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
                    detectedProxy = profile.proxyWallet;
                    walletType = 'MetaMask (proxy wallet)';
                }
            }
            catch (_) { /* ignore */ }
        }
        // Fetch on-chain pUSD balance of proxy (or EOA)
        const balanceTarget = detectedProxy || eoaAddress;
        let onchainBalance = 0;
        try {
            onchainBalance = await getMyBalance(balanceTarget);
        }
        catch (_) { /* ignore */ }
        // Count open positions
        let openPositions = 0;
        try {
            const positions = await fetchData(`https://data-api.polymarket.com/positions?user=${balanceTarget}`);
            if (Array.isArray(positions))
                openPositions = positions.filter((p) => p.size > 0).length;
        }
        catch (_) { /* ignore */ }
        res.json({
            address: eoaAddress,
            proxyWallet: detectedProxy,
            walletType,
            onchainBalance,
            openPositions
        });
    }
    catch (e) {
        res.status(400).json({ error: 'Chave Privada Inválida ou Malformada' });
    }
});
app.post('/api/user/import-wallet', authenticateToken, async (req, res) => {
    try {
        let { privateKey, proxyAddress } = req.body;
        if (!privateKey)
            return res.status(400).json({ error: 'Private key required' });
        // Cleanup key and ensure 0x prefix
        privateKey = privateKey.trim();
        if (!privateKey.startsWith('0x'))
            privateKey = '0x' + privateKey;
        if (privateKey.length !== 66) {
            return res.status(400).json({ error: 'Chave privada inválida (formato incorreto)' });
        }
        if (proxyAddress)
            proxyAddress = proxyAddress.trim();
        if (proxyAddress && !proxyAddress.startsWith('0x'))
            proxyAddress = '0x' + proxyAddress;
        const wallet = new ethers.Wallet(privateKey);
        const eoaAddress = wallet.address;
        // Auto-detect proxy wallet if not provided
        let detectedProxy = proxyAddress || undefined;
        if (!detectedProxy) {
            try {
                const profile = await fetchData(`https://gamma-api.polymarket.com/public-profile?address=${eoaAddress}`);
                if (profile && profile.proxyWallet && profile.proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
                    detectedProxy = profile.proxyWallet;
                }
            }
            catch (_) { /* ignore */ }
        }
        const user = await User.findById(req.user?.id);
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        if (user.config?.enabled) {
            return res.status(400).json({ error: 'Desative o robô no dashboard antes de importar uma nova carteira' });
        }
        user.wallet = {
            address: eoaAddress,
            privateKey: wallet.privateKey,
            ...(detectedProxy ? { proxyAddress: detectedProxy } : {})
        };
        // Keep ready state if swapping wallet
        if (user.step !== 'ready')
            user.step = 'setup';
        await user.save();
        console.log(`[WALLET] Imported wallet for ${user.username || user.chatId}: ${eoaAddress} (Proxy: ${detectedProxy || 'None'})`);
        res.json({ success: true, address: eoaAddress, proxyAddress: detectedProxy });
    }
    catch (e) {
        console.error('[WALLET] Import error:', e);
        res.status(400).json({ error: 'Chave Privada InvÃ¡lida ou Malformada' });
    }
});
app.post('/api/user/update-config', authenticateToken, async (req, res) => {
    const user = await User.findById(req.user?.id);
    if (!user)
        return res.status(404).json({ error: 'User not found' });
    const { traderAddress, enabled, strategy, copySize, reverseCopy, orderType, slippageBuy, slippageSell, tpPercent, slPercent, balanceSl, triggerDelta, hedgeCeiling, minPrice, maxPrice, minTradeSize, maxTradeSize, copyBuy, copySell, maxExposure, buyAtMin, maxPerMarket, maxPerToken, totalSpendLimit, sniperModeSec, lastMinuteModeSec, maxMarketCount, minMarketLiquidity, mode, proxyAddress } = req.body;
    if (!user.config)
        user.config = { enabled: false, strategy: 'PERCENTAGE', copySize: 10.0, traderAddress: '' };
    if (traderAddress !== undefined)
        user.config.traderAddress = traderAddress;
    if (enabled !== undefined)
        user.config.enabled = enabled;
    if (strategy !== undefined)
        user.config.strategy = strategy;
    if (copySize !== undefined)
        user.config.copySize = copySize;
    // Advanced fields
    if (reverseCopy !== undefined)
        user.config.reverseCopy = reverseCopy;
    if (orderType !== undefined)
        user.config.orderType = orderType;
    if (slippageBuy !== undefined)
        user.config.slippageBuy = slippageBuy;
    if (slippageSell !== undefined)
        user.config.slippageSell = slippageSell;
    if (balanceSl !== undefined)
        user.config.balanceSl = balanceSl;
    if (triggerDelta !== undefined)
        user.config.triggerDelta = triggerDelta;
    if (hedgeCeiling !== undefined)
        user.config.hedgeCeiling = hedgeCeiling;
    if (tpPercent !== undefined)
        user.config.tpPercent = tpPercent;
    if (slPercent !== undefined)
        user.config.slPercent = slPercent;
    if (minPrice !== undefined)
        user.config.minPrice = minPrice;
    if (maxPrice !== undefined)
        user.config.maxPrice = maxPrice;
    if (minTradeSize !== undefined)
        user.config.minTradeSize = minTradeSize;
    if (maxTradeSize !== undefined)
        user.config.maxTradeSize = maxTradeSize;
    if (copyBuy !== undefined)
        user.config.copyBuy = copyBuy;
    if (copySell !== undefined)
        user.config.copySell = copySell;
    if (maxExposure !== undefined)
        user.config.maxExposure = maxExposure;
    if (buyAtMin !== undefined)
        user.config.buyAtMin = buyAtMin;
    if (maxPerMarket !== undefined)
        user.config.maxPerMarket = maxPerMarket;
    if (maxPerToken !== undefined)
        user.config.maxPerToken = maxPerToken;
    if (totalSpendLimit !== undefined)
        user.config.totalSpendLimit = totalSpendLimit;
    if (sniperModeSec !== undefined)
        user.config.sniperModeSec = sniperModeSec;
    if (lastMinuteModeSec !== undefined)
        user.config.lastMinuteModeSec = lastMinuteModeSec;
    if (maxMarketCount !== undefined)
        user.config.maxMarketCount = maxMarketCount;
    if (minMarketLiquidity !== undefined)
        user.config.minMarketLiquidity = minMarketLiquidity;
    if (mode !== undefined)
        user.config.mode = mode;
    // Wallet settings
    if (proxyAddress !== undefined && user.wallet) {
        user.wallet.proxyAddress = proxyAddress;
    }
    if (req.body.finalize === true) {
        user.step = 'ready';
    }
    await user.save();
    res.json({ success: true });
});
app.get('/api/user/positions', authenticateToken, async (req, res) => {
    try {
        const user = req.fullUser;
        if (!user || !user.wallet || !user.wallet.address) {
            return res.status(400).json({ error: 'Carteira nÃ£o configurada' });
        }
        const positionsData = await fetchData(`https://data-api.polymarket.com/positions?user=${user.wallet.address}`);
        if (!Array.isArray(positionsData)) {
            return res.json([]);
        }
        // Filter valid open positions and calculate live P&L
        const activePositions = positionsData.filter(p => p.size > 0 && p.currentValue > 0).map(pos => {
            const entryPrice = pos.avgPrice || 0;
            const curPrice = pos.currentValue / pos.size;
            let pnlPercent = 0;
            if (entryPrice > 0) {
                pnlPercent = ((curPrice - entryPrice) / entryPrice) * 100;
            }
            return {
                asset: pos.asset,
                title: pos.title,
                slug: pos.slug,
                size: pos.size,
                currentValue: pos.currentValue,
                avgPrice: entryPrice,
                curPrice: curPrice,
                pnlPercent: pnlPercent,
                assetName: pos.outcome || 'Token',
            };
        });
        // Ensure descending order by value
        activePositions.sort((a, b) => b.currentValue - a.currentValue);
        res.json(activePositions);
    }
    catch (e) {
        console.error('Error fetching positions:', e);
        res.status(500).json({ error: 'Erro ao buscar posiÃ§Ãµes' });
    }
});
app.get('/api/user/trades', authenticateToken, async (req, res) => {
    try {
        const { Activity } = await import('../models/userHistory.js');
        const user = req.fullUser;
        const userId = req.user?.id?.toString();
        const traderAddress = user?.config?.traderAddress?.toLowerCase();
        // Build query: show all trades from trader being monitored, OR any processed by this user
        const query = traderAddress
            ? { $or: [{ traderAddress }, { processedBy: userId }], type: 'TRADE' }
            : { processedBy: userId, type: 'TRADE' };
        const tradesData = await Activity.find(query).sort({ timestamp: -1 }).limit(50).lean();
        // Enrich with current market price for P&L calculation
        const enriched = await Promise.all(tradesData.map(async (t) => {
            let curPrice = null;
            let pnlPercent = null;
            let pnlLabel = '';
            try {
                if (t.asset) {
                    const mktRes = await fetchData(`https://clob.polymarket.com/markets/${t.conditionId}`);
                    const token = mktRes?.tokens?.find((tk) => tk.token_id === t.asset);
                    if (token) {
                        curPrice = parseFloat(token.price);
                        if (t.price && curPrice !== null) {
                            const entryPrice = parseFloat(t.price);
                            if (t.side === 'BUY') {
                                pnlPercent = ((curPrice - entryPrice) / entryPrice) * 100;
                            }
                            else {
                                pnlPercent = ((entryPrice - curPrice) / entryPrice) * 100;
                            }
                            pnlLabel = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(1) + '%';
                        }
                    }
                }
            }
            catch (_) { /* best-effort */ }
            // Determine this user's execution status
            const userStatus = userId && t.followerStatuses?.[userId];
            let executionStatus;
            let executionDetails = '';
            if (userStatus) {
                executionStatus = userStatus.status;
                executionDetails = userStatus.details || '';
            }
            else if (t.processedBy?.includes(userId)) {
                executionStatus = 'SUCESSO';
            }
            else {
                // Was detected but not attempted for this user yet or not their trader
                executionStatus = t.traderAddress === traderAddress ? 'DETECTADO' : 'OUTRO';
            }
            // Extract user's own execution data
            const myEntryAmount = userStatus?.myEntryAmount || null;
            const myEntryPrice = userStatus?.myEntryPrice || null;
            // Calculate user's real P&L in USD
            let myPnlUSD = null;
            let myPnlLabel = '';
            let myCurrentValue = null;
            if (myEntryAmount !== null && myEntryPrice !== null && curPrice !== null) {
                const myTokens = myEntryAmount / myEntryPrice;
                myCurrentValue = myTokens * curPrice;
                myPnlUSD = myCurrentValue - myEntryAmount;
                myPnlLabel = (myPnlUSD >= 0 ? '+$' : '-$') + Math.abs(myPnlUSD).toFixed(2);
            }
            return {
                _id: t._id,
                timestamp: t.timestamp,
                title: t.title || t.slug || 'Mercado Desconhecido',
                slug: t.slug,
                eventSlug: t.eventSlug,
                side: t.side,
                usdcSize: t.usdcSize,
                price: t.price,
                curPrice,
                pnlPercent,
                pnlLabel,
                myEntryAmount,
                myEntryPrice,
                myCurrentValue,
                myPnlUSD,
                myPnlLabel,
                outcome: t.outcome,
                transactionHash: t.transactionHash,
                executionStatus,
                executionDetails,
                isChainDetected: t.isChainDetected || false,
                pseudonym: t.pseudonym,
                name: t.name,
                profileImage: t.profileImage
            };
        }));
        res.json(enriched);
    }
    catch (e) {
        console.error('[TRADES]', e);
        res.status(500).json({ error: 'Failed to fetch trades' });
    }
});
app.get('/api/user/stats', authenticateToken, async (req, res) => {
    try {
        const user = req.fullUser;
        const eoa = user.wallet?.address;
        if (!eoa)
            return res.json({ balance: 0, exposure: 0 });
        const proxyInfo = await findProxyWallet(user);
        const proxy = proxyInfo?.address || null;
        // Fetch CLOB balance (if client is available)
        let clobBalance = 0;
        try {
            const clobClient = await getClobClientForUser(user);
            if (clobClient) {
                clobBalance = await getMyBalance(clobClient);
            }
        }
        catch (clobErr) {
            console.error(`[STATS] CLOB balance error for ${user.chatId}:`, clobErr);
        }
        // Sum balances of EOA and Proxy via FAST RPC
        const [balEoa, balProxy] = await Promise.all([
            getMyBalance(eoa),
            proxy ? getMyBalance(proxy) : Promise.resolve(0)
        ]);
        const userIdentifier = user.username || user.chatId || user._id;
        const totalBalance = balEoa + balProxy + clobBalance;
        const targetAddr = proxy || eoa;
        const positionsData = await fetchData(`https://data-api.polymarket.com/positions?user=${targetAddr}`);
        const exposure = (positionsData || []).reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
        Logger.debug(`[STATS_API] Components for ${userIdentifier}: EOA=${balEoa}, Proxy=${balProxy}, CLOB=${clobBalance} -> Total=${totalBalance}`);
        res.json({
            balance: parseFloat(totalBalance.toFixed(4)),
            exposure: parseFloat(exposure.toFixed(2)),
            proxy
        });
    }
    catch (e) {
        console.error('Stats error:', e);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});
app.get('/', authenticateToken, (req, res) => {
    const userRole = req.user?.role || 'follower';
    console.log(`[DASHBOARD] Routing user ${req.user?.username} with role ${userRole}`);
    if (userRole === 'admin') {
        res.type('html').send(adminDashboardHtml);
    }
    else {
        res.type('html').send(userDashboardHtml);
    }
});
export const startServer = async (port = parseInt(process.env.PORT || '3000')) => {
    await bootstrapAdmin();
    botStartTime = Date.now();
    app.listen(port, '0.0.0.0', () => {
        console.log(`\nðŸŒ Web UI:  http://0.0.0.0:${port}`);
        console.log(`ðŸ“– Swagger: http://0.0.0.0:${port}/docs`);
        console.log(`ðŸ”Œ API:     http://0.0.0.0:${port}/api/health\n`);
    });
};
export default app;
