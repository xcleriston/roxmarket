// Copy this entire file content and paste into polycopy/src/server/index.ts
// after the existing /api/config endpoint (around line 80)

// ============================================================================
// USER API ENDPOINTS - Wallet, Balance, and Dashboard Support
// ============================================================================

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

// Update user configuration
app.post('/api/user/update-config', authenticateToken, async (req: AuthRequest, res) => {
    try {
        const user = await User.findById(req.user?.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const {
            traderAddress, enabled, strategy, copySize,
            reverseCopy, orderType, slippageBuy, slippageSell,
            minPrice, maxPrice, minTradeSize, maxTradeSize,
            mode, proxyAddress
        } = req.body;
        
        if (!user.config) user.config = { enabled: false, strategy: 'PERCENTAGE', copySize: 10.0, traderAddress: '' };
        
        if (traderAddress !== undefined) user.config.traderAddress = traderAddress;
        if (enabled !== undefined) user.config.enabled = enabled;
        if (strategy !== undefined) user.config.strategy = strategy;
        if (copySize !== undefined) user.config.copySize = copySize;
        if (reverseCopy !== undefined) user.config.reverseCopy = reverseCopy;
        if (orderType !== undefined) user.config.orderType = orderType;
        if (slippageBuy !== undefined) user.config.slippageBuy = slippageBuy;
        if (slippageSell !== undefined) user.config.slippageSell = slippageSell;
        if (minPrice !== undefined) user.config.minPrice = minPrice;
        if (maxPrice !== undefined) user.config.maxPrice = maxPrice;
        if (minTradeSize !== undefined) user.config.minTradeSize = minTradeSize;
        if (maxTradeSize !== undefined) user.config.maxTradeSize = maxTradeSize;
        if (mode !== undefined) user.config.mode = mode;
        if (proxyAddress !== undefined) user.config.proxyAddress = proxyAddress;
        
        await user.save();
        res.json({ success: true, config: user.config });
    } catch (error) {
        console.error('[CONFIG] Update error:', error);
        res.status(500).json({ error: 'Failed to update config' });
    }
});
