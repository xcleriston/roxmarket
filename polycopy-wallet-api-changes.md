# PolyCopy Wallet & Balance API Changes

This document describes the changes needed to add wallet detection and balance loading endpoints to the polycopy repository.

## Files to Modify

### 1. src/server/index.ts

Add the following endpoints after the existing `/api/config` endpoint (around line 80):

```typescript
// Enrichen AuthRequest with full User data for all /api/user/ routes
app.use('/api/user/', async (req: any, _res, next) => {
    if (req.user?.id) {
        req.fullUser = await User.findById(req.user.id).lean();
    }
    next();
});

app.get('/api/user/me', authenticateToken, async (req: AuthRequest, res) => {
    const user = (req as any).fullUser;
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

// Get monitored trader info explicitly
app.get('/api/user/trader', authenticateToken, async (req: AuthRequest, res) => {
    const user = (req as any).fullUser;
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    
    const traderAddress = user.config?.traderAddress;
    if (!traderAddress) {
        return res.json({ 
            monitored: false,
            message: 'No trader configured'
        });
    }
    
    res.json({
        monitored: true,
        traderAddress: traderAddress.toLowerCase(),
        traderAddressShort: traderAddress.slice(0, 6) + '...' + traderAddress.slice(-4),
        strategy: user.config?.strategy || 'PERCENTAGE',
        copySize: user.config?.copySize || 10.0,
        enabled: user.config?.enabled || false
    });
});

// Get user balance (USDC)
app.get('/api/user/balance', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const user = (req as any).fullUser;
        if (!user?.wallet?.address) return res.json({ balance: 0, source: 'none' });
        
        const { getClobClientForUser } = await import('../utils/createClobClient.js');
        const getMyBalance = (await import('../utils/getMyBalance.js')).default;
        
        const clobClient = await getClobClientForUser(user);
        let balance = 0;
        let source = 'onchain';
        
        if (clobClient) {
            balance = await getMyBalance(clobClient);
            source = 'clob';
        } else {
            // Fallback to on-chain balance
            const proxyAddr = user.wallet?.proxyAddress || user.wallet?.address;
            balance = await getMyBalance(proxyAddr);
        }
        
        res.json({ 
            balance,
            source,
            address: user.wallet?.address,
            proxyAddress: user.wallet?.proxyAddress
        });
    } catch (error) {
        console.error('[BALANCE] Error:', error);
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// Get user positions
app.get('/api/user/positions', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const user = (req as any).fullUser;
        if (!user?.wallet?.address) return res.json({ positions: [], count: 0 });
        
        const fetchData = (await import('../utils/fetchData.js')).default;
        const targetAddr = user.wallet?.proxyAddress || user.wallet?.address;
        
        const positions = await fetchData(`https://data-api.polymarket.com/positions?user=${targetAddr}`);
        const openPositions = Array.isArray(positions) 
            ? positions.filter((p: any) => p.size > 0)
            : [];
        
        res.json({
            positions: openPositions,
            count: openPositions.length,
            totalValue: openPositions.reduce((sum: number, p: any) => sum + (p.currentValue || 0), 0)
        });
    } catch (error) {
        console.error('[POSITIONS] Error:', error);
        res.status(500).json({ error: 'Failed to fetch positions' });
    }
});

// Preview wallet before importing
app.post('/api/user/validate-wallet-preview', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const { ethers } = await import('ethers');
        let { privateKey, proxyAddress } = req.body;
        
        if (!privateKey) return res.status(400).json({ error: 'Private key required' });
        
        privateKey = privateKey.trim();
        if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
        if (privateKey.length !== 66) return res.status(400).json({ error: 'Invalid private key format' });

        const wallet = new ethers.Wallet(privateKey);
        const eoaAddress = wallet.address;

        let detectedProxy = proxyAddress || null;
        let walletType = proxyAddress ? 'MetaMask (proxy manual)' : 'EOA';

        // Auto-detect proxy wallet from Polymarket public-profile
        if (!detectedProxy) {
            try {
                const fetchData = (await import('../utils/fetchData.js')).default;
                const profile = await fetchData(`https://gamma-api.polymarket.com/public-profile?address=${eoaAddress}`);
                if (profile?.proxyWallet && profile.proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
                    detectedProxy = profile.proxyWallet;
                    walletType = 'MetaMask (proxy wallet)';
                }
            } catch (_) { /* ignore */ }
        }

        // Fetch on-chain USDC balance
        const getMyBalance = (await import('../utils/getMyBalance.js')).default;
        const balanceTarget = detectedProxy || eoaAddress;
        const onchainBalance = await getMyBalance(balanceTarget);

        // Count open positions
        let openPositions = 0;
        try {
            const fetchData = (await import('../utils/fetchData.js')).default;
            const positions = await fetchData(`https://data-api.polymarket.com/positions?user=${balanceTarget}`);
            if (Array.isArray(positions)) openPositions = positions.filter((p: any) => p.size > 0).length;
        } catch (_) { /* ignore */ }

        res.json({
            address: eoaAddress,
            proxyWallet: detectedProxy,
            walletType,
            onchainBalance,
            openPositions
        });
    } catch (e) {
        res.status(400).json({ error: 'Invalid private key' });
    }
});

// Import wallet
app.post('/api/user/import-wallet', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const { ethers } = await import('ethers');
        let { privateKey, proxyAddress } = req.body;
        
        if (!privateKey) return res.status(400).json({ error: 'Private key required' });
        
        privateKey = privateKey.trim();
        if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
        if (privateKey.length !== 66) return res.status(400).json({ error: 'Invalid private key format' });

        const wallet = new ethers.Wallet(privateKey);
        const eoaAddress = wallet.address;

        // Auto-detect proxy wallet
        let detectedProxy = proxyAddress || undefined;
        if (!detectedProxy) {
            try {
                const fetchData = (await import('../utils/fetchData.js')).default;
                const profile = await fetchData(`https://gamma-api.polymarket.com/public-profile?address=${eoaAddress}`);
                if (profile?.proxyWallet && profile.proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
                    detectedProxy = profile.proxyWallet;
                }
            } catch (_) { /* ignore */ }
        }

        const user = await User.findById(req.user?.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.config?.enabled) {
            return res.status(400).json({ error: 'Disable bot in dashboard before importing a new wallet' });
        }

        user.wallet = {
            address: eoaAddress,
            privateKey: wallet.privateKey,
            ...(detectedProxy ? { proxyAddress: detectedProxy } : {})
        };
        if (user.step !== 'ready') user.step = 'setup';
        await user.save();
        
        console.log(`[WALLET] Imported wallet for ${user.username || user.chatId}: ${eoaAddress} (Proxy: ${detectedProxy || 'None'})`);
        res.json({ success: true, address: eoaAddress, proxyAddress: detectedProxy });
    } catch (e) {
        console.error('[WALLET] Import error:', e);
        res.status(400).json({ error: 'Invalid private key' });
    }
});

// Generate new wallet
app.post('/api/user/generate-wallet', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const user = await User.findById(req.user?.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.config?.enabled) {
            return res.status(400).json({ error: 'Disable bot in dashboard before changing wallet' });
        }

        const { ethers } = await import('ethers');
        const newWallet = ethers.Wallet.createRandom();
        
        user.wallet = {
            address: newWallet.address,
            privateKey: newWallet.privateKey
        };
        if (user.step !== 'ready') user.step = 'setup';
        await user.save();
        
        console.log(`[WALLET] Generated new wallet for ${user.username || user.chatId}: ${newWallet.address}`);
        res.json({ 
            success: true, 
            address: newWallet.address, 
            privateKey: newWallet.privateKey 
        });
    } catch (e) {
        console.error('[WALLET] Generation error:', e);
        res.status(500).json({ error: 'Failed to generate wallet' });
    }
});
```

### 2. Ensure imports exist at top of src/server/index.ts

Make sure these imports exist:
```typescript
import { ethers } from 'ethers';
```

### 3. Ensure auth middleware provides req.user.id

Check that the `authenticateToken` middleware in `src/server/auth.ts` decodes and sets `req.user` with the user id:

```typescript
const decoded = jwt.verify(token, JWT_SECRET) as any;
req.user = decoded; // Should have id, role, username
```

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/user/me` | GET | Get current user data |
| `/api/user/trader` | GET | Get monitored trader info |
| `/api/user/balance` | GET | Get USDC balance (on-chain or CLOB) |
| `/api/user/positions` | GET | Get open positions |
| `/api/user/validate-wallet-preview` | POST | Preview wallet before import |
| `/api/user/import-wallet` | POST | Import existing wallet |
| `/api/user/generate-wallet` | POST | Generate new random wallet |

## Response Examples

### GET /api/user/balance
```json
{
  "balance": 2.99,
  "source": "clob",
  "address": "0x...",
  "proxyAddress": "0x..."
}
```

### GET /api/user/positions
```json
{
  "positions": [...],
  "count": 5,
  "totalValue": 150.50
}
```

### POST /api/user/validate-wallet-preview
```json
{
  "address": "0x...",
  "proxyWallet": "0x...",
  "walletType": "MetaMask (proxy wallet)",
  "onchainBalance": 100.50,
  "openPositions": 3
}
```
