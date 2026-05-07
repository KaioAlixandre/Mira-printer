const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/auth');
const authorize = require('../middleware/authorize');

router.get('/', async (req, res) => {
  try {
    const categories = await prisma.categoria_adicional.findMany({
      where: { lojaId: req.lojaId },
      orderBy: { nome: 'asc' },
      include: {
        _count: {
          select: { adicionais: true }
        }
      }
    });

    const transformedCategories = categories.map((cat) => ({
      id: cat.id,
      name: cat.nome,
      additionalsCount: cat._count.adicionais,
      createdAt: cat.criadoEm,
      updatedAt: cat.atualizadoEm
    }));

    res.status(200).json(transformedCategories);
  } catch (err) {
    res.status(500).json({ message: 'Erro ao buscar categorias.', error: err.message });
  }
});

router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
  }

  try {
    const newCategory = await prisma.categoria_adicional.create({
      data: { nome: name.trim(), lojaId: req.lojaId }
    });

    res.status(201).json({
      id: newCategory.id,
      name: newCategory.nome,
      createdAt: newCategory.criadoEm,
      updatedAt: newCategory.atualizadoEm
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ message: 'Já existe uma categoria com este nome.' });
    }

    res.status(500).json({ message: 'Erro ao criar categoria.', error: err.message });
  }
});

router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
  }

  try {
    const existingCategory = await prisma.categoria_adicional.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingCategory) {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }

    const updatedCategory = await prisma.categoria_adicional.update({
      where: { id: parseInt(id) },
      data: { nome: name.trim() }
    });

    res.status(200).json({
      id: updatedCategory.id,
      name: updatedCategory.nome,
      createdAt: updatedCategory.criadoEm,
      updatedAt: updatedCategory.atualizadoEm
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ message: 'Já existe uma categoria com este nome.' });
    }

    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }

    res.status(500).json({ message: 'Erro ao atualizar categoria.', error: err.message });
  }
});

router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const additionalsCount = await prisma.adicional.count({
      where: { categoriaId: parseInt(id) }
    });

    if (additionalsCount > 0) {
      return res.status(400).json({
        message: `Não é possível deletar. Esta categoria possui ${additionalsCount} adicional(is) associado(s).`
      });
    }

    await prisma.categoria_adicional.delete({
      where: { id: parseInt(id) }
    });

    res.status(200).json({ message: 'Categoria deletada com sucesso.' });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }

    res.status(500).json({ message: 'Erro ao deletar categoria.', error: err.message });
  }
});

module.exports = router;
