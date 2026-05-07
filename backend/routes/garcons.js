const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');

// Função para remover máscara do telefone (somente dígitos)
function removePhoneMask(phone) {
  if (!phone) return phone;
  return phone.toString().replace(/\D/g, '');
}

// Pedidos que entram nas métricas: delivery/pickup nos status de conclusão; mesa só quando fechada (closed)
function whereContaParaMetricas() {
  return {
    OR: [
      { tipoEntrega: { not: 'dine_in' }, status: { in: ['being_prepared', 'ready_for_pickup', 'on_the_way', 'delivered'] } },
      { tipoEntrega: 'dine_in', status: 'closed' },
    ],
  };
}

// GET - Listar garçons
router.get('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const garcons = await prisma.usuario.findMany({
      where: {
        lojaId: req.lojaId,
        funcao: 'waiter',
      },
      select: {
        id: true,
        nomeUsuario: true,
        email: true,
        funcao: true,
        telefone: true,
        criadoEm: true,
      },
      orderBy: { criadoEm: 'desc' },
    });

    res.json(garcons);
  } catch (error) {
    console.error('[GET /api/garcons] Erro:', error);
    res.status(500).json({ message: 'Erro ao buscar garçons.' });
  }
});

// GET - Métricas agregadas por garçom (total pedidos, LTV médio e valor total)
router.get('/stats', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const pedidosPorGarcom = await prisma.pedido.groupBy({
      by: ['criadoPorUsuarioId'],
      where: {
        lojaId: req.lojaId,
        criadoPorUsuarioId: { not: null },
        ...whereContaParaMetricas(),
      },
      _sum: { precoTotal: true },
      _count: { id: true },
    });

    const stats = pedidosPorGarcom.map((row) => {
      const garcomId = row.criadoPorUsuarioId;
      const totalPedidos = row._count.id || 0;
      const valorTotal = Number(row._sum.precoTotal || 0);
      const ltvMedio = totalPedidos > 0 ? valorTotal / totalPedidos : 0;

      return {
        garcomId,
        totalPedidos,
        ltvMedio,
        valorTotal,
      };
    });

    res.json(stats);
  } catch (error) {
    console.error('[GET /api/garcons/stats] Erro:', error);
    res.status(500).json({ message: 'Erro ao buscar métricas dos garçons.' });
  }
});

// POST - Criar novo garçom
router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { nomeUsuario, email, senha, telefone } = req.body || {};

    if (!nomeUsuario || !email || !senha || !telefone) {
      return res
        .status(400)
        .json({ message: 'Nome, email, senha e telefone são obrigatórios.' });
    }

    const emailNorm = String(email).trim().toLowerCase();

    if (!emailNorm) {
      return res.status(400).json({ message: 'Email precisa ser válido.' });
    }

    const telefoneLimpo = removePhoneMask(telefone);
    if (!telefoneLimpo || telefoneLimpo.length < 10 || telefoneLimpo.length > 11) {
      return res.status(400).json({ message: 'Telefone inválido. Informe DDD e número (10 ou 11 dígitos).' });
    }

    const existingByEmail = await prisma.usuario.findFirst({
      where: { lojaId: req.lojaId, email: emailNorm, funcao: 'waiter' },
      select: { id: true },
    });

    if (existingByEmail) {
      return res.status(409).json({ message: 'Já existe um usuário com este email.' });
    }

    const existingByTelefone = await prisma.usuario.findFirst({
      where: { lojaId: req.lojaId, telefone: telefoneLimpo, funcao: 'waiter' },
      select: { id: true },
    });

    if (existingByTelefone) {
      return res.status(409).json({ message: 'Já existe um usuário com este telefone.' });
    }

    const hashedPassword = await bcrypt.hash(String(senha), 10);

    const garcon = await prisma.usuario.create({
      data: {
        lojaId: req.lojaId,
        nomeUsuario: String(nomeUsuario).trim(),
        email: emailNorm,
        telefone: telefoneLimpo,
        senha: hashedPassword,
        funcao: 'waiter',
      },
      select: {
        id: true,
        nomeUsuario: true,
        email: true,
        funcao: true,
        telefone: true,
        criadoEm: true,
      },
    });

    res.status(201).json(garcon);
  } catch (error) {
    console.error('[POST /api/garcons] Erro:', error);
    res.status(500).json({ message: 'Erro ao cadastrar garçom.' });
  }
});

// DELETE - Remover garçom
router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const garconId = parseInt(req.params.id);
    if (Number.isNaN(garconId)) {
      return res.status(400).json({ message: 'ID inválido.' });
    }

    const existing = await prisma.usuario.findFirst({
      where: { id: garconId, lojaId: req.lojaId, funcao: 'waiter' },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Garçom não encontrado.' });
    }

    await prisma.usuario.delete({ where: { id: garconId } });
    res.json({ message: 'Garçom removido com sucesso.' });
  } catch (error) {
    console.error('[DELETE /api/garcons/:id] Erro:', error);
    res.status(500).json({ message: 'Erro ao remover garçom.' });
  }
});

// PUT - Atualizar garçom (nome, email e telefone)
router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const garconId = parseInt(req.params.id);
    if (Number.isNaN(garconId)) {
      return res.status(400).json({ message: 'ID inválido.' });
    }

    const { nomeUsuario, email, telefone } = req.body || {};

    if (!nomeUsuario || !email || !telefone) {
      return res.status(400).json({ message: 'Nome, email e telefone são obrigatórios.' });
    }

    const nomeUsuarioTrim = String(nomeUsuario).trim();
    const emailNorm = String(email).trim().toLowerCase();

    if (!nomeUsuarioTrim) {
      return res.status(400).json({ message: 'Nome inválido.' });
    }

    if (!emailNorm) {
      return res.status(400).json({ message: 'Email inválido.' });
    }

    const telefoneLimpo = removePhoneMask(telefone);
    if (!telefoneLimpo || telefoneLimpo.length < 10 || telefoneLimpo.length > 11) {
      return res.status(400).json({ message: 'Telefone inválido. Informe DDD e número (10 ou 11 dígitos).' });
    }

    const existing = await prisma.usuario.findFirst({
      where: { id: garconId, lojaId: req.lojaId, funcao: 'waiter' },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Garçom não encontrado.' });
    }

    const emailTaken = await prisma.usuario.findFirst({
      where: {
        lojaId: req.lojaId,
        funcao: 'waiter',
        email: emailNorm,
        NOT: { id: garconId },
      },
      select: { id: true },
    });

    if (emailTaken) {
      return res.status(409).json({ message: 'Já existe um garçom com este email.' });
    }

    const telefoneTaken = await prisma.usuario.findFirst({
      where: {
        lojaId: req.lojaId,
        funcao: 'waiter',
        telefone: telefoneLimpo,
        NOT: { id: garconId },
      },
      select: { id: true },
    });

    if (telefoneTaken) {
      return res.status(409).json({ message: 'Já existe um garçom com este telefone.' });
    }

    const updated = await prisma.usuario.update({
      where: { id: garconId },
      data: {
        nomeUsuario: nomeUsuarioTrim,
        email: emailNorm,
        telefone: telefoneLimpo,
      },
      select: {
        id: true,
        nomeUsuario: true,
        email: true,
        funcao: true,
        telefone: true,
        criadoEm: true,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('[PUT /api/garcons/:id] Erro:', error);
    res.status(500).json({ message: 'Erro ao atualizar garçom.' });
  }
});

module.exports = router;

