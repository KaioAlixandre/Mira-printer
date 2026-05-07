const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const router = express.Router();

const multer = require('multer');
const cloudinary = require('../services/cloudinary');
const streamifier = require('streamifier');

// Middlewares de autenticação e autorização
const { authenticateToken, authorize } = require('./auth');

// Configuração do multer para upload em memória
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test((file.originalname || '').toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas'));
    }
  }
});

// 🍓 GET - Listar todos os sabores (apenas ativos por padrão)
router.get('/', async (req, res) => {
  console.log('📋 GET /flavors - Listando sabores...');
  
  try {
    const { includeInactive } = req.query;
    
    const flavors = await prisma.sabor.findMany({
      where: includeInactive === 'true' ? { lojaId: req.lojaId } : { lojaId: req.lojaId, ativo: true },
      orderBy: { nome: 'asc' },
      include: {
        categoria: true
      }
    });

    // Transformar campos do português para inglês
    const transformedFlavors = flavors.map(flavor => ({
      id: flavor.id,
      name: flavor.nome,
      imageUrl: flavor.imagemUrl,
      isActive: flavor.ativo,
      categoryId: flavor.categoriaId,
      category: flavor.categoria ? {
        id: flavor.categoria.id,
        name: flavor.categoria.nome
      } : null,
      createdAt: flavor.criadoEm,
      updatedAt: flavor.atualizadoEm
    }));

    console.log(`✅ Encontrados ${flavors.length} sabores`);
    res.json(transformedFlavors);
  } catch (error) {
    console.error('❌ Erro ao buscar sabores:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// 🔍 GET - Buscar sabor por ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`🔍 GET /flavors/${id} - Buscando sabor específico...`);
  
  try {
    const flavor = await prisma.sabor.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId },
      include: {
        categoria: true
      }
    });

    if (!flavor) {
      console.log('❌ Sabor não encontrado');
      return res.status(404).json({ message: 'Sabor não encontrado' });
    }

    // Transformar campos do português para inglês
    const transformedFlavor = {
      id: flavor.id,
      name: flavor.nome,
      imageUrl: flavor.imagemUrl,
      isActive: flavor.ativo,
      categoryId: flavor.categoriaId,
      category: flavor.categoria ? {
        id: flavor.categoria.id,
        name: flavor.categoria.nome
      } : null,
      createdAt: flavor.criadoEm,
      updatedAt: flavor.atualizadoEm
    };

    console.log(`✅ Sabor encontrado: ${flavor.nome}`);
    res.json(transformedFlavor);
  } catch (error) {
    console.error('❌ Erro ao buscar sabor:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// ➕ POST - Criar novo sabor (APENAS ADMIN)
router.post('/', authenticateToken, authorize('admin'), upload.single('image'), async (req, res) => {
  const { nome, ativo = true, categoriaId } = req.body;
  console.log(`➕ POST /flavors - Usuário autenticado:`, {
    id: req.user?.id,
    username: req.user?.username,
    role: req.user?.role
  });
  console.log(`➕ POST /flavors - Criando sabor: ${nome}`);
  
  try {
    // Validação
    if (!nome || nome.trim().length === 0) {
      console.log('❌ Nome do sabor é obrigatório');
      return res.status(400).json({ message: 'Nome do sabor é obrigatório' });
    }

    if (nome.length > 100) {
      console.log('❌ Nome muito longo');
      return res.status(400).json({ message: 'Nome deve ter no máximo 100 caracteres' });
    }

    // Verificar se já existe um sabor com o mesmo nome
    const existingFlavor = await prisma.sabor.findFirst({
      where: { nome: nome.trim(), lojaId: req.lojaId }
    });

    if (existingFlavor) {
      console.log('❌ Sabor já existe');
      return res.status(409).json({ message: 'Já existe um sabor com este nome' });
    }

    // Processar imagem se foi enviada (Cloudinary)
    let imagemUrl = null;
    if (req.file) {
      const streamUpload = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({ folder: 'flavors' }, (error, result) => {
            if (result) {
              resolve(result.secure_url);
            } else {
              reject(error);
            }
          });
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
      };
      imagemUrl = await streamUpload();
    }

    // Criar o sabor
    const flavor = await prisma.sabor.create({
      data: {
        lojaId: req.lojaId,
        nome: nome.trim(),
        imagemUrl: imagemUrl,
        ativo: Boolean(ativo),
        categoriaId: categoriaId ? parseInt(categoriaId) : null
      },
      include: {
        categoria: true
      }
    });

    // Transformar campos do português para inglês
    const transformedFlavor = {
      id: flavor.id,
      name: flavor.nome,
      imageUrl: flavor.imagemUrl,
      isActive: flavor.ativo,
      categoryId: flavor.categoriaId,
      category: flavor.categoria ? {
        id: flavor.categoria.id,
        name: flavor.categoria.nome
      } : null,
      createdAt: flavor.criadoEm,
      updatedAt: flavor.atualizadoEm
    };

    console.log(`✅ Sabor criado com ID: ${flavor.id}`);
    res.status(201).json(transformedFlavor);
  } catch (error) {
    console.error('❌ Erro ao criar sabor:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// ✏️ PUT - Atualizar sabor (APENAS ADMIN)
router.put('/:id', authenticateToken, authorize('admin'), upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { nome, ativo, categoriaId } = req.body;
  console.log(`✏️ PUT /flavors/${id} - Admin ${req.user.username} atualizando sabor...`);

  try {
    // Verificar se o sabor existe
    const existingFlavor = await prisma.sabor.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingFlavor) {
      console.log('❌ Sabor não encontrado');
      return res.status(404).json({ message: 'Sabor não encontrado' });
    }

    // Preparar dados para atualização
    let imagemUrl = existingFlavor.imagemUrl;
    if (req.file) {
      const streamUpload = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({ folder: 'flavors' }, (error, result) => {
            if (result) {
              resolve(result.secure_url);
            } else {
              reject(error);
            }
          });
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
      };
      imagemUrl = await streamUpload();
    }

    const updateData = {
      imagemUrl
    };

    if (nome !== undefined) {
      if (!nome || nome.trim().length === 0) {
        console.log('❌ Nome do sabor não pode estar vazio');
        return res.status(400).json({ message: 'Nome do sabor não pode estar vazio' });
      }

      if (nome.length > 100) {
        console.log('❌ Nome muito longo');
        return res.status(400).json({ message: 'Nome deve ter no máximo 100 caracteres' });
      }

      // Verificar se já existe outro sabor com o mesmo nome
      const duplicateFlavor = await prisma.sabor.findFirst({
        where: {
          nome: nome.trim(),
          lojaId: req.lojaId,
          id: { not: parseInt(id) }
        }
      });

      if (duplicateFlavor) {
        console.log('❌ Nome já existe em outro sabor');
        return res.status(409).json({ message: 'Já existe outro sabor com este nome' });
      }

      updateData.nome = nome.trim();
    }

    if (ativo !== undefined) {
      updateData.ativo = Boolean(ativo);
    }

    if (categoriaId !== undefined) {
      updateData.categoriaId = categoriaId ? parseInt(categoriaId) : null;
    }

    // Atualizar o sabor
    const flavor = await prisma.sabor.update({
      where: { id: parseInt(id) },
      data: updateData,
      include: {
        categoria: true
      }
    });

    // Transformar campos do português para inglês
    const transformedFlavor = {
      id: flavor.id,
      name: flavor.nome,
      imageUrl: flavor.imagemUrl,
      isActive: flavor.ativo,
      categoryId: flavor.categoriaId,
      category: flavor.categoria ? {
        id: flavor.categoria.id,
        name: flavor.categoria.nome
      } : null,
      createdAt: flavor.criadoEm,
      updatedAt: flavor.atualizadoEm
    };

    console.log(`✅ Sabor atualizado: ${flavor.nome}`);
    res.json(transformedFlavor);
  } catch (error) {
    console.error('❌ Erro ao atualizar sabor:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// 🗑️ DELETE - Deletar sabor (APENAS ADMIN)
router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  console.log(`🗑️ DELETE /flavors/${id} - Admin ${req.user.username} deletando sabor...`);
  
  try {
    // Verificar se o sabor existe
    const existingFlavor = await prisma.sabor.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingFlavor) {
      console.log('❌ Sabor não encontrado');
      return res.status(404).json({ message: 'Sabor não encontrado' });
    }

    // Deletar o sabor
    await prisma.sabor.delete({
      where: { id: parseInt(id) }
    });

    // Transformar campos do português para inglês
    const transformedFlavor = {
      id: existingFlavor.id,
      name: existingFlavor.nome,
      imageUrl: existingFlavor.imagemUrl,
      isActive: existingFlavor.ativo,
      createdAt: existingFlavor.criadoEm,
      updatedAt: existingFlavor.atualizadoEm
    };

    console.log(`✅ Sabor deletado: ${existingFlavor.nome}`);
    res.json({ message: 'Sabor deletado com sucesso', deletedFlavor: transformedFlavor });
  } catch (error) {
    console.error('❌ Erro ao deletar sabor:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// 🔄 PATCH - Alternar status ativo/inativo (APENAS ADMIN)
router.patch('/:id/toggle', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  console.log(`🔄 PATCH /flavors/${id}/toggle - Admin ${req.user.username} alternando status...`);
  
  try {
    // Verificar se o sabor existe
    const existingFlavor = await prisma.sabor.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingFlavor) {
      console.log('❌ Sabor não encontrado');
      return res.status(404).json({ message: 'Sabor não encontrado' });
    }

    // Alternar o status
    const flavor = await prisma.sabor.update({
      where: { id: parseInt(id) },
      data: { ativo: !existingFlavor.ativo }
    });

    // Transformar campos do português para inglês
    const transformedFlavor = {
      id: flavor.id,
      name: flavor.nome,
      imageUrl: flavor.imagemUrl,
      isActive: flavor.ativo,
      createdAt: flavor.criadoEm,
      updatedAt: flavor.atualizadoEm
    };

    const status = flavor.ativo ? 'ativado' : 'desativado';
    console.log(`✅ Sabor ${status}: ${flavor.nome}`);
    res.json({ 
      message: `Sabor ${status} com sucesso`, 
      flavor: transformedFlavor 
    });
  } catch (error) {
    console.error('❌ Erro ao alternar status do sabor:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = router;

