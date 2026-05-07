const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');

// Função para remover máscara do telefone (garantir apenas dígitos)
const removePhoneMask = (phone) => {
    if (!phone) return phone;
    return phone.toString().replace(/\D/g, '');
};

// GET - Listar todos os entregadores
router.get('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const deliverers = await prisma.entregador.findMany({
      where: { lojaId: req.lojaId },
      orderBy: { criadoEm: 'desc' },
      include: {
        pedidos: {
          where: {
            lojaId: req.lojaId,
            status: 'delivered'
          }
        }
      }
    });

    // Transformar campos do português para inglês
    const transformedDeliverers = deliverers.map(deliverer => ({
      id: deliverer.id,
      name: deliverer.nome,
      phone: deliverer.telefone,
      email: deliverer.email,
      isActive: deliverer.ativo,
      createdAt: deliverer.criadoEm,
      updatedAt: deliverer.atualizadoEm,
      deliveriesCount: deliverer.pedidos.length
    }));

    res.json(transformedDeliverers);
  } catch (error) {
    console.error('Erro ao buscar entregadores:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// POST - Criar novo entregador
router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { nome, telefone, email } = req.body;

    if (!nome || !telefone) {
      return res.status(400).json({ message: 'Nome e telefone são obrigatórios' });
    }

    // Remover máscara do telefone antes de salvar
    const telefoneLimpo = removePhoneMask(telefone);

    // Verificar se já existe entregador com o mesmo telefone
    const existingDeliverer = await prisma.entregador.findFirst({
      where: { telefone: telefoneLimpo, lojaId: req.lojaId }
    });

    if (existingDeliverer) {
      return res.status(400).json({ message: 'Já existe um entregador com este telefone' });
    }

    const deliverer = await prisma.entregador.create({
      data: {
        lojaId: req.lojaId,
        nome,
        telefone: telefoneLimpo,
        email: email || null
      }
    });

    // Transformar campos do português para inglês
    const transformedDeliverer = {
      id: deliverer.id,
      name: deliverer.nome,
      phone: deliverer.telefone,
      email: deliverer.email,
      isActive: deliverer.ativo,
      createdAt: deliverer.criadoEm,
      updatedAt: deliverer.atualizadoEm
    };

    res.status(201).json(transformedDeliverer);
  } catch (error) {
    console.error('Erro ao criar entregador:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// PUT - Atualizar entregador
router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, telefone, email, ativo } = req.body;

    if (!nome || !telefone) {
      return res.status(400).json({ message: 'Nome e telefone são obrigatórios' });
    }

    // Remover máscara do telefone antes de salvar
    const telefoneLimpo = removePhoneMask(telefone);

    // Verificar se o entregador existe
    const existingDeliverer = await prisma.entregador.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingDeliverer) {
      return res.status(404).json({ message: 'Entregador não encontrado' });
    }

    // Verificar se outro entregador já tem o mesmo telefone
    const delivererWithSamePhone = await prisma.entregador.findFirst({
      where: { 
        telefone: telefoneLimpo,
        lojaId: req.lojaId,
        id: { not: parseInt(id) }
      }
    });

    if (delivererWithSamePhone) {
      return res.status(400).json({ message: 'Já existe um entregador com este telefone' });
    }

    const deliverer = await prisma.entregador.update({
      where: { id: parseInt(id) },
      data: {
        nome,
        telefone: telefoneLimpo,
        email: email || null,
        ativo: ativo !== undefined ? ativo : true
      }
    });

    // Transformar campos do português para inglês
    const transformedDeliverer = {
      id: deliverer.id,
      name: deliverer.nome,
      phone: deliverer.telefone,
      email: deliverer.email,
      isActive: deliverer.ativo,
      createdAt: deliverer.criadoEm,
      updatedAt: deliverer.atualizadoEm
    };

    res.json(transformedDeliverer);
  } catch (error) {
    console.error('Erro ao atualizar entregador:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// DELETE - Remover entregador
router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se o entregador existe
    const existingDeliverer = await prisma.entregador.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingDeliverer) {
      return res.status(404).json({ message: 'Entregador não encontrado' });
    }

    await prisma.entregador.delete({
      where: { id: parseInt(id) }
    });

    res.json({ message: 'Entregador removido com sucesso' });
  } catch (error) {
    console.error('Erro ao remover entregador:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// PATCH - Ativar/Desativar entregador
router.patch('/:id/toggle', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const deliverer = await prisma.entregador.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!deliverer) {
      return res.status(404).json({ message: 'Entregador não encontrado' });
    }

    const updatedDeliverer = await prisma.entregador.update({
      where: { id: parseInt(id) },
      data: { ativo: !deliverer.ativo }
    });

    // Transformar campos do português para inglês
    const transformedDeliverer = {
      id: updatedDeliverer.id,
      name: updatedDeliverer.nome,
      phone: updatedDeliverer.telefone,
      email: updatedDeliverer.email,
      isActive: updatedDeliverer.ativo,
      createdAt: updatedDeliverer.criadoEm,
      updatedAt: updatedDeliverer.atualizadoEm
    };

    res.json(transformedDeliverer);
  } catch (error) {
    console.error('Erro ao alterar status do entregador:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = router;