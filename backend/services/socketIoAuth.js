const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET;

/** CSV em env, ex.: admin,master */
function allowedRoles() {
  const raw = process.env.SOCKET_PRINTER_ROLES || 'admin,master';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Middleware Socket.IO: handshake.auth.token (JWT igual ao HTTP Bearer).
 * Valida usuário, papel e associa à room loja_<lojaId>.
 */
function createSocketAuthMiddleware() {
  return async (socket, next) => {
    try {
      if (!JWT_SECRET) {
        console.error('[socket-auth] JWT_SECRET não configurado');
        return next(new Error('SERVER_MISCONFIGURED'));
      }

      const auth = socket.handshake.auth || {};
      const token = auth.token || auth.accessToken || auth.jwt;
      if (!token || typeof token !== 'string') {
        return next(new Error('MISSING_TOKEN'));
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await prisma.usuario.findUnique({
        where: { id: decoded.id },
        include: { loja: true },
      });

      if (!user || user.lojaId == null) {
        return next(new Error('INVALID_USER'));
      }

      const roles = allowedRoles();
      if (!roles.includes(user.funcao)) {
        console.warn(`[socket-auth] Função não permitida: ${user.funcao} (socket ${socket.id})`);
        return next(new Error('FORBIDDEN_ROLE'));
      }

      const room = `loja_${user.lojaId}`;
      socket.join(room);
      socket.data.lojaId = user.lojaId;
      socket.data.userId = user.id;
      socket.data.role = user.funcao;

      return next();
    } catch (err) {
      if (err?.name === 'TokenExpiredError') {
        return next(new Error('TOKEN_EXPIRED'));
      }
      if (err?.name === 'JsonWebTokenError') {
        return next(new Error('INVALID_TOKEN'));
      }
      console.error('[socket-auth]', err?.message || err);
      return next(new Error('UNAUTHORIZED'));
    }
  };
}

module.exports = { createSocketAuthMiddleware };
