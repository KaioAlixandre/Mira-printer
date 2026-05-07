const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/auth');
const authorize = require('../middleware/authorize');

// Listar todas as categorias de complementos
router.get('/', async (req, res) => {
  console.log('📂 GET /api/complement-categories: Requisição para listar todas as categorias de complementos.');
  try {
    const categories = await prisma.categoria_complemento.findMany({
      where: { lojaId: req.lojaId },
      orderBy: { nome: 'asc' },
      include: {
        _count: {
          select: { complementos: true }
        }
      }
    });
    
    const transformedCategories = categories.map(cat => ({
      id: cat.id,
      name: cat.nome,
      complementsCount: cat._count.complementos,
      createdAt: cat.criadoEm,
      updatedAt: cat.atualizadoEm
    }));
    
    console.log(`✅ GET /api/complement-categories: ${categories.length} categorias listadas com sucesso.`);
    res.status(200).json(transformedCategories);
  } catch (err) {
    console.error('❌ GET /api/complement-categories: Erro ao buscar categorias:', err.message);
    res.status(500).json({ message: 'Erro ao buscar categorias.', error: err.message });
  }
});

// Criar nova categoria de complemento (admin)
router.post('/', authenticateToken, authorize('admin'), async (req, res) => {
  const { name } = req.body;
  console.log(`✨ POST /api/complement-categories: Requisição para criar categoria: ${name}.`);
  
  if (!name || !name.trim()) {
    console.warn('⚠️ POST /api/complement-categories: Nome da categoria ausente.');
    return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
  }

  try {
    const newCategory = await prisma.categoria_complemento.create({
      data: { nome: name.trim(), lojaId: req.lojaId }
    });
    
    console.log(`✅ POST /api/complement-categories: Categoria criada com sucesso: ${newCategory.nome}.`);
    res.status(201).json({
      id: newCategory.id,
      name: newCategory.nome,
      createdAt: newCategory.criadoEm,
      updatedAt: newCategory.atualizadoEm
    });
  } catch (err) {
    console.error('❌ POST /api/complement-categories: Erro ao criar categoria:', err.message);
    
    if (err.code === 'P2002') {
      return res.status(400).json({ message: 'Já existe uma categoria com este nome.' });
    }
    
    res.status(500).json({ message: 'Erro ao criar categoria.', error: err.message });
  }
});

// Atualizar categoria de complemento (admin)
router.put('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  console.log(`🔄 PUT /api/complement-categories/${id}: Requisição para atualizar categoria.`);
  
  if (!name || !name.trim()) {
    console.warn('⚠️ PUT /api/complement-categories: Nome da categoria ausente.');
    return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
  }

  try {
    const existingCategory = await prisma.categoria_complemento.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingCategory) {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }

    const updatedCategory = await prisma.categoria_complemento.update({
      where: { id: parseInt(id) },
      data: { nome: name.trim() }
    });
    
    console.log(`✅ PUT /api/complement-categories/${id}: Categoria atualizada com sucesso.`);
    res.status(200).json({
      id: updatedCategory.id,
      name: updatedCategory.nome,
      createdAt: updatedCategory.criadoEm,
      updatedAt: updatedCategory.atualizadoEm
    });
  } catch (err) {
    console.error(`❌ PUT /api/complement-categories/${id}: Erro ao atualizar categoria:`, err.message);
    
    if (err.code === 'P2002') {
      return res.status(400).json({ message: 'Já existe uma categoria com este nome.' });
    }
    
    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }
    
    res.status(500).json({ message: 'Erro ao atualizar categoria.', error: err.message });
  }
});

// Deletar categoria de complemento (admin)
router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  console.log(`🗑️ DELETE /api/complement-categories/${id}: Requisição para deletar categoria.`);
  
  try {
    // Verificar se há complementos nesta categoria
    const complementsCount = await prisma.complemento.count({
      where: { categoriaId: parseInt(id) }
    });
    
    if (complementsCount > 0) {
      console.warn(`⚠️ DELETE /api/complement-categories/${id}: Categoria possui ${complementsCount} complementos.`);
      return res.status(400).json({ 
        message: `Não é possível deletar. Esta categoria possui ${complementsCount} complemento(s) associado(s).` 
      });
    }
    
    await prisma.categoria_complemento.delete({
      where: { id: parseInt(id) }
    });
    
    console.log(`✅ DELETE /api/complement-categories/${id}: Categoria deletada com sucesso.`);
    res.status(200).json({ message: 'Categoria deletada com sucesso.' });
  } catch (err) {
    console.error(`❌ DELETE /api/complement-categories/${id}: Erro ao deletar categoria:`, err.message);
    
    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Categoria não encontrada.' });
    }
    
    res.status(500).json({ message: 'Erro ao deletar categoria.', error: err.message });
  }
});

module.exports = router;
