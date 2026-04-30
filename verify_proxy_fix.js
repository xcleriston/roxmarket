
import mongoose from 'mongoose';
import { getClobClientForUser } from './dist/utils/createClobClient.js';
import User from './dist/models/user.js';
import { ENV } from './dist/config/env.js';
import Logger from './dist/utils/logger.js';

async function verify() {
    console.log('🚀 INICIANDO VERIFICAÇÃO DE PERSISTÊNCIA DE PROXY\n');
    
    try {
        await mongoose.connect(ENV.MONGODB_URI || 'mongodb://localhost:27017/polycopy');
        console.log('✅ Conectado ao MongoDB');
        
        // Find a user with a wallet
        const user = await User.findOne({ 'wallet.address': { $exists: true } });
        if (!user) {
            console.log('❌ Nenhum usuário encontrado com carteira configurada.');
            return;
        }
        
        console.log(`\n--- Usuário: ${user._id} ---`);
        console.log('Carteira EOA:', user.wallet.address);
        console.log('Proxy Atual (DB):', user.wallet.proxyAddress || 'Nenhum');
        console.log('SigType Atual (DB):', user.wallet.signatureType || 'Nenhum');
        
        console.log('\n🔍 Chamando getClobClientForUser (isso deve detectar e persistir o proxy)...');
        const client = await getClobClientForUser(user);
        
        if (client) {
            console.log('✅ Cliente CLOB inicializado com sucesso.');
        } else {
            console.log('⚠️  Falha ao inicializar cliente CLOB (pode ser assinatura inválida).');
        }
        
        // Re-fetch user from DB to see if it was persisted
        const updatedUser = await User.findById(user._id);
        console.log('\n--- Resultado no Banco de Dados ---');
        console.log('Proxy Persistido:', updatedUser.wallet.proxyAddress || 'Nenhum');
        console.log('SigType Persistido:', updatedUser.wallet.signatureType || 'Nenhum');
        console.log('Status Verificado:', updatedUser.wallet.isProxyVerified);
        
        if (updatedUser.wallet.isProxyVerified) {
            console.log('\n✅ SUCESSO: A detecção e persistência funcionaram corretamente!');
        } else {
            console.log('\n❌ FALHA: As informações não foram persistidas no DB.');
        }
        
    } catch (e) {
        console.error('❌ Erro durante verificação:', e);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

verify();
