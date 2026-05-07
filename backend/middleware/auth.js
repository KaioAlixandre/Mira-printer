const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'KaioNext123';

async function authenticateToken(req, res, next) {
    console.log('🔗 [authenticateToken] Verificando token de autenticação...');
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: Bearer TOKEN

    if (token == null) {
        console.warn('⚠️ [authenticateToken] Token não fornecido. Acesso negado.');
        return res.status(401).json({ message: 'Token não fornecido.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('🔍 [authenticateToken] Token decodificado:', decoded);
        
        // Busca os dados atualizados do usuário no banco
        const user = await prisma.usuario.findUnique({
            where: { id: decoded.id },
            select: { id: true, funcao: true, nomeUsuario: true, telefone: true }
        });
        
        if (!user) {
            console.error('❌ [authenticateToken] Usuário não encontrado para o token fornecido.');
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        
        req.user = user;
        console.log(`✅ [authenticateToken] Autenticação bem-sucedida para o usuário ID: ${req.user.id}, Nome: ${req.user.nomeUsuario}, Função: ${req.user.funcao}`);
        next();
    } catch (err) {
        if (err?.name === 'TokenExpiredError') {
            console.warn('⏰ [authenticateToken] Token expirado:', err.message);
            return res.status(401).json({ message: 'Token expirado.' });
        }

        console.error('🚫 [authenticateToken] Token inválido:', err.message);
        return res.status(403).json({ message: 'Token inválido.' });
    }
}

module.exports = authenticateToken;