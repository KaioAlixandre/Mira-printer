const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken } = require('./auth');

// Endpoint temporário para debug - verificar usuário atual
router.get('/debug/user', authenticateToken, (req, res) => {
  console.log('🔍 Debug - Usuário atual:', req.user);
  res.json({
    user: req.user,
    timestamp: new Date()
  });
});

// Endpoint para testar dados de usuários com pedidos (sem autenticação para teste)
router.get('/debug/users', async (req, res) => {
  try {
    console.log('🔍 Debug - Buscando usuários com pedidos...');
    
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
        order: {
          select: {
            id: true,
            totalPrice: true,
            status: true,
            createdAt: true
          }
        }
      }
    });
    
    console.log('📊 Debug - Resultado da query:', JSON.stringify(users, null, 2));
    
    // Calcular estatísticas
    const stats = users.map(user => ({
      id: user.id,
      username: user.username,
      totalPedidos: user.order?.length || 0,
      totalGasto: user.order?.reduce((acc, order) => acc + Number(order.totalPrice), 0) || 0
    }));
    
    console.log('📈 Debug - Estatísticas calculadas:', stats);
    
    res.json({
      users,
      stats,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('❌ Debug - Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;