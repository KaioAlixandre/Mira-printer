const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware para verificar o token e adicionar o usuário à requisição
const authenticateToken = async (req, res, next) => {
    console.log('🔗 [Middleware: authenticateToken] Verificando token de autenticação...');
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        console.warn('⚠️ [Middleware: authenticateToken] Token não fornecido. Acesso negado.');
        return res.status(401).json({ message: 'Token não fornecido.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await prisma.usuario.findUnique({
            where: { id: decoded.id },
            select: { id: true, funcao: true } // Seleciona apenas o id e o papel
        });

        if (!user) {
            console.error('❌ [Middleware: authenticateToken] Usuário não encontrado para o token fornecido.');
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        req.user = user;
        console.log(`✅ [Middleware: authenticateToken] Autenticação bem-sucedida para o usuário ID: ${req.user.id}.`);
        next();
    } catch (err) {
        console.error('🚫 [Middleware: authenticateToken] Token inválido:', err.message);
        return res.status(403).json({ message: 'Token inválido.' });
    }
};

// Middleware para verificar o papel do usuário (admin, user, etc.)
const authorize = (role) => {
    return (req, res, next) => {
        console.log(`🔗 [Middleware: authorize] Verificando se o usuário tem o papel '${role}'.`);
        if (!req.user || req.user.funcao !== role) {
            console.warn(`🚫 [Middleware: authorize] Acesso negado. Papel necessário: '${role}', Papel do usuário: '${req.user ? req.user.funcao : 'não autenticado'}'`);
            return res.status(403).json({ message: 'Acesso negado: você não tem permissão para realizar esta ação.' });
        }
        console.log(`✅ [Middleware: authorize] Autorização bem-sucedida para o papel '${role}'.`);
        next();
    };
};

module.exports = {
    authenticateToken,
    authorize,
    prisma
};