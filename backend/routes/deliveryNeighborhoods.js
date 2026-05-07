const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');

function normalizeNeighborhoodName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

router.get('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const lojaId = req.lojaId;
    if (lojaId == null || typeof lojaId !== 'number') {
      return res.status(400).json({ message: 'Loja não identificada. Verifique o subdomínio ou o header x-loja-subdominio.' });
    }
    const bairros = await prisma.bairro_entrega.findMany({
      where: { lojaId },
      orderBy: { nomeNormalizado: 'asc' }
    });

    res.json(
      bairros.map((b) => ({
        id: b.id,
        nome: b.nome,
        taxaEntrega: Number(b.taxaEntrega),
        criadoEm: b.criadoEm,
        atualizadoEm: b.atualizadoEm
      }))
    );
  } catch (error) {
    console.error('Erro ao listar bairros de entrega:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const { nome, taxaEntrega } = req.body;

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ message: 'Nome do bairro é obrigatório' });
    }

    const nomeNormalizado = normalizeNeighborhoodName(nome);
    const taxa = taxaEntrega === '' || taxaEntrega === null || taxaEntrega === undefined ? 0 : Number(taxaEntrega);
    if (!Number.isFinite(taxa) || taxa < 0) {
      return res.status(400).json({ message: 'Taxa de entrega inválida' });
    }

    const existing = await prisma.bairro_entrega.findFirst({
      where: { lojaId: req.lojaId, nomeNormalizado }
    });

    if (existing) {
      return res.status(409).json({ message: 'Já existe um bairro com este nome' });
    }

    const created = await prisma.bairro_entrega.create({
      data: {
        lojaId: req.lojaId,
        nome: String(nome).trim(),
        nomeNormalizado,
        taxaEntrega: taxa
      }
    });

    res.status(201).json({
      id: created.id,
      nome: created.nome,
      taxaEntrega: Number(created.taxaEntrega)
    });
  } catch (error) {
    console.error('Erro ao criar bairro de entrega:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const { nome, taxaEntrega } = req.body;

    const bairro = await prisma.bairro_entrega.findFirst({
      where: { id, lojaId: req.lojaId }
    });

    if (!bairro) {
      return res.status(404).json({ message: 'Bairro não encontrado' });
    }

    const data = {};

    if (nome !== undefined) {
      if (!String(nome).trim()) {
        return res.status(400).json({ message: 'Nome do bairro é obrigatório' });
      }
      const nomeNormalizado = normalizeNeighborhoodName(nome);

      const duplicate = await prisma.bairro_entrega.findFirst({
        where: { lojaId: req.lojaId, nomeNormalizado, id: { not: id } }
      });

      if (duplicate) {
        return res.status(409).json({ message: 'Já existe outro bairro com este nome' });
      }

      data.nome = String(nome).trim();
      data.nomeNormalizado = nomeNormalizado;
    }

    if (taxaEntrega !== undefined) {
      const taxa = taxaEntrega === '' || taxaEntrega === null ? 0 : Number(taxaEntrega);
      if (!Number.isFinite(taxa) || taxa < 0) {
        return res.status(400).json({ message: 'Taxa de entrega inválida' });
      }
      data.taxaEntrega = taxa;
    }

    const updated = await prisma.bairro_entrega.update({
      where: { id },
      data
    });

    res.json({
      id: updated.id,
      nome: updated.nome,
      taxaEntrega: Number(updated.taxaEntrega)
    });
  } catch (error) {
    console.error('Erro ao atualizar bairro de entrega:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const bairro = await prisma.bairro_entrega.findFirst({
      where: { id, lojaId: req.lojaId }
    });

    if (!bairro) {
      return res.status(404).json({ message: 'Bairro não encontrado' });
    }

    await prisma.bairro_entrega.delete({ where: { id } });
    res.json({ message: 'Bairro removido com sucesso' });
  } catch (error) {
    console.error('Erro ao remover bairro de entrega:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// Public list (for customer address form)
router.get('/list', async (req, res) => {
  try {
    const bairros = await prisma.bairro_entrega.findMany({
      where: { lojaId: req.lojaId },
      orderBy: { nome: 'asc' }
    });
    res.json(bairros.map((b) => ({ id: b.id, nome: b.nome, taxaEntrega: Number(b.taxaEntrega) })));
  } catch (error) {
    console.error('Erro ao listar bairros (público):', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.get('/fee', async (req, res) => {
  try {
    const bairroQuery = req.query.bairro;
    const bairroNome = String(bairroQuery || '').trim();

    const config = await prisma.configuracao_loja.findUnique({
      where: { lojaId: req.lojaId }
    });

    const taxaPadrao = Number(config?.taxaEntrega ?? 0);

    if (!bairroNome) {
      return res.json({ taxaEntrega: taxaPadrao, bairroEncontrado: false });
    }

    const nomeNormalizado = normalizeNeighborhoodName(bairroNome);

    const bairro = await prisma.bairro_entrega.findFirst({
      where: { lojaId: req.lojaId, nomeNormalizado }
    });

    if (!bairro) {
      return res.json({ taxaEntrega: taxaPadrao, bairroEncontrado: false });
    }

    return res.json({
      taxaEntrega: Number(bairro.taxaEntrega),
      bairroEncontrado: true,
      bairro: { id: bairro.id, nome: bairro.nome }
    });
  } catch (error) {
    console.error('Erro ao buscar taxa por bairro:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = { router, normalizeNeighborhoodName };
