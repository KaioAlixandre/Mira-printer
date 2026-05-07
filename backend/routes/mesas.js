const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');

console.log('🚀 [MesasRoutes] Módulo de rotas de mesas carregado');

// Listar todas as mesas da loja
// Permitimos acesso também para "waiter" (garçom) para que ele consiga ver as mesas.
router.get(
  '/',
  authenticateToken,
  async (req, res, next) => {
    const allowedRoles = ['admin', 'master', 'waiter'];
    const role = req.user?.funcao;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: 'Acesso negado: você não tem permissão para ver as mesas.' });
    }
    next();
  },
  async (req, res) => {
  console.log('🔍 [GET /api/mesas] Buscando mesas');

  try {
    const mesas = await prisma.mesa.findMany({
      where: { lojaId: req.lojaId },
      orderBy: { criadoEm: 'desc' },
    });

    console.log(`✅ [GET /api/mesas] ${mesas.length} mesas encontradas`);
    res.json(mesas);
  } catch (error) {
    console.error('❌ [GET /api/mesas] Erro:', error);
    res.status(500).json({ error: 'Erro ao buscar mesas' });
  }
  },
);

// Criar nova mesa
router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  console.log('➕ [POST /api/mesas] Criando nova mesa');
  console.log('📥 Dados recebidos:', req.body);

  const { nome, identificador, ativo } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'Nome da mesa é obrigatório' });
  }

  try {
    // Evita duplicar mesas com mesmo nome na mesma loja
    const existingMesaByName = await prisma.mesa.findFirst({
      where: {
        lojaId: req.lojaId,
        nome: nome.trim(),
      },
    });

    if (existingMesaByName) {
      return res.status(400).json({ error: 'Já existe uma mesa com este nome' });
    }

    // Se tiver identificador, evita duplicar na mesma loja
    if (identificador && identificador.trim()) {
      const existingMesaByIdent = await prisma.mesa.findFirst({
        where: {
          lojaId: req.lojaId,
          identificador: identificador.trim(),
        },
      });

      if (existingMesaByIdent) {
        return res.status(400).json({ error: 'Já existe uma mesa com este identificador' });
      }
    }

    const mesa = await prisma.mesa.create({
      data: {
        lojaId: req.lojaId,
        nome: nome.trim(),
        identificador: identificador?.trim() || null,
        ativo: ativo !== undefined ? !!ativo : true,
      },
    });

    console.log(`✅ [POST /api/mesas] Mesa criada: ${mesa.nome} (ID: ${mesa.id})`);
    res.status(201).json(mesa);
  } catch (error) {
    console.error('❌ [POST /api/mesas] Erro:', error);
    res.status(500).json({ error: 'Erro ao criar mesa' });
  }
});

// Atualizar mesa
router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  console.log(`🔄 [PUT /api/mesas/${id}] Atualizando mesa`);
  console.log('📥 Dados recebidos:', req.body);

  const { nome, identificador, ativo } = req.body;

  try {
    const existingMesa = await prisma.mesa.findFirst({
      where: { id: parseInt(id, 10), lojaId: req.lojaId },
    });

    if (!existingMesa) {
      return res.status(404).json({ error: 'Mesa não encontrada' });
    }

    if (nome && nome.trim()) {
      const duplicateByName = await prisma.mesa.findFirst({
        where: {
          lojaId: req.lojaId,
          nome: nome.trim(),
          id: { not: parseInt(id, 10) },
        },
      });

      if (duplicateByName) {
        return res.status(400).json({ error: 'Já existe outra mesa com este nome' });
      }
    }

    if (identificador && identificador.trim()) {
      const duplicateByIdent = await prisma.mesa.findFirst({
        where: {
          lojaId: req.lojaId,
          identificador: identificador.trim(),
          id: { not: parseInt(id, 10) },
        },
      });

      if (duplicateByIdent) {
        return res.status(400).json({ error: 'Já existe outra mesa com este identificador' });
      }
    }

    const mesa = await prisma.mesa.update({
      where: { id: parseInt(id, 10) },
      data: {
        nome: nome !== undefined ? nome.trim() : existingMesa.nome,
        identificador:
          identificador !== undefined
            ? identificador.trim() || null
            : existingMesa.identificador,
        ativo: ativo !== undefined ? !!ativo : existingMesa.ativo,
      },
    });

    console.log(`✅ [PUT /api/mesas/${id}] Mesa atualizada: ${mesa.nome}`);
    res.json(mesa);
  } catch (error) {
    console.error(`❌ [PUT /api/mesas/${id}] Erro:`, error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Mesa não encontrada' });
    }
    res.status(500).json({ error: 'Erro ao atualizar mesa' });
  }
});

// Fechar mesa: marca todos os pedidos da mesa como "closed" e registra forma de pagamento
// Pedidos com status closed entram nas métricas; antes disso não entram.
router.post(
  '/fechar',
  authenticateToken,
  async (req, res, next) => {
    const allowedRoles = ['admin', 'master', 'waiter'];
    const role = req.user?.funcao;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: 'Acesso negado: você não tem permissão para fechar mesa.' });
    }
    next();
  },
  async (req, res) => {
  console.log('🔒 [POST /api/mesas/fechar] Fechando mesa');
  const { identificador, metodoPagamento } = req.body;

  if (!identificador || !String(identificador).trim()) {
    return res.status(400).json({ error: 'Identificador da mesa é obrigatório' });
  }

  const metodo = String(metodoPagamento || '').toUpperCase();
  const metodosValidos = ['PIX', 'CASH_ON_DELIVERY', 'CREDIT_CARD'];
  const metodoFinal = metodosValidos.includes(metodo) ? metodo : 'CASH_ON_DELIVERY';

  try {
    const identificadorNorm = String(identificador).trim();
    const pedidosMesa = await prisma.pedido.findMany({
      where: {
        lojaId: req.lojaId,
        tipoEntrega: 'dine_in',
        identificadorMesaSenha: identificadorNorm,
        status: { not: 'canceled' }
      },
      select: { id: true }
    });

    if (pedidosMesa.length === 0) {
      return res.status(200).json({
        message: 'Nenhum pedido ativo nesta mesa para fechar',
        closedCount: 0
      });
    }

    const ids = pedidosMesa.map((p) => p.id);
    await prisma.pedido.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'closed',
        metodoPagamento: metodoFinal
      }
    });

    console.log(`✅ [POST /api/mesas/fechar] Mesa fechada: ${ids.length} pedido(s), método: ${metodoFinal}`);
    res.status(200).json({
      message: 'Mesa fechada com sucesso',
      closedCount: ids.length,
      metodoPagamento: metodoFinal
    });
  } catch (error) {
    console.error('❌ [POST /api/mesas/fechar] Erro:', error);
    res.status(500).json({ error: 'Erro ao fechar mesa' });
  }
});

// Excluir mesa
router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  console.log(`🗑️ [DELETE /api/mesas/${id}] Excluindo mesa`);

  try {
    const existingMesa = await prisma.mesa.findFirst({
      where: { id: parseInt(id, 10), lojaId: req.lojaId },
    });

    if (!existingMesa) {
      return res.status(404).json({ error: 'Mesa não encontrada' });
    }

    await prisma.mesa.delete({
      where: { id: parseInt(id, 10) },
    });

    console.log(`✅ [DELETE /api/mesas/${id}] Mesa excluída com sucesso`);
    res.json({ message: 'Mesa excluída com sucesso' });
  } catch (error) {
    console.error(`❌ [DELETE /api/mesas/${id}] Erro:`, error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Mesa não encontrada' });
    }
    res.status(500).json({ error: 'Erro ao excluir mesa' });
  }
});

module.exports = router;


