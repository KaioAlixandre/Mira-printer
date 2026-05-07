const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const router = express.Router();

const multer = require('multer');
const cloudinary = require('../services/cloudinary');
const streamifier = require('streamifier');

const { authenticateToken, authorize } = require('./auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
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

router.get('/', async (req, res) => {
  try {
    const { includeInactive } = req.query;

    const additionals = await prisma.adicional.findMany({
      where: includeInactive === 'true' ? { lojaId: req.lojaId } : { lojaId: req.lojaId, ativo: true },
      orderBy: { nome: 'asc' },
      include: {
        categoria: true
      }
    });

    const transformedAdditionals = additionals.map((additional) => ({
      id: additional.id,
      name: additional.nome,
      value: Number(additional.valor),
      imageUrl: additional.imagemUrl,
      isActive: additional.ativo,
      categoryId: additional.categoriaId,
      category: additional.categoria ? {
        id: additional.categoria.id,
        name: additional.categoria.nome
      } : null,
      createdAt: additional.criadoEm,
      updatedAt: additional.atualizadoEm
    }));

    res.json(transformedAdditionals);
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const additional = await prisma.adicional.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId },
      include: {
        categoria: true
      }
    });

    if (!additional) {
      return res.status(404).json({ message: 'Adicional não encontrado' });
    }

    const transformedAdditional = {
      id: additional.id,
      name: additional.nome,
      value: Number(additional.valor),
      imageUrl: additional.imagemUrl,
      isActive: additional.ativo,
      categoryId: additional.categoriaId,
      category: additional.categoria ? {
        id: additional.categoria.id,
        name: additional.categoria.nome
      } : null,
      createdAt: additional.criadoEm,
      updatedAt: additional.atualizadoEm
    };

    res.json(transformedAdditional);
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.post('/', authenticateToken, authorize('admin'), upload.single('image'), async (req, res) => {
  const { nome, valor, ativo = true, categoriaId } = req.body;

  try {
    if (!nome || nome.trim().length === 0) {
      return res.status(400).json({ message: 'Nome do adicional é obrigatório' });
    }

    if (nome.length > 100) {
      return res.status(400).json({ message: 'Nome deve ter no máximo 100 caracteres' });
    }

    const parsedValue = valor === undefined || valor === null || valor === '' ? 0 : Number(valor);
    if (Number.isNaN(parsedValue) || parsedValue < 0) {
      return res.status(400).json({ message: 'Valor inválido' });
    }

    const existingAdditional = await prisma.adicional.findFirst({
      where: { nome: nome.trim(), lojaId: req.lojaId }
    });

    if (existingAdditional) {
      return res.status(409).json({ message: 'Já existe um adicional com este nome' });
    }

    let imagemUrl = null;
    if (req.file) {
      const streamUpload = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({ folder: 'additionals' }, (error, result) => {
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

    const additional = await prisma.adicional.create({
      data: {
        lojaId: req.lojaId,
        nome: nome.trim(),
        valor: parsedValue,
        imagemUrl: imagemUrl,
        ativo: Boolean(ativo),
        categoriaId: categoriaId ? parseInt(categoriaId) : null
      },
      include: {
        categoria: true
      }
    });

    const transformedAdditional = {
      id: additional.id,
      name: additional.nome,
      value: Number(additional.valor),
      imageUrl: additional.imagemUrl,
      isActive: additional.ativo,
      categoryId: additional.categoriaId,
      category: additional.categoria ? {
        id: additional.categoria.id,
        name: additional.categoria.nome
      } : null,
      createdAt: additional.criadoEm,
      updatedAt: additional.atualizadoEm
    };

    res.status(201).json(transformedAdditional);
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.put('/:id', authenticateToken, authorize('admin'), upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { nome, valor, ativo, categoriaId } = req.body;

  try {
    const existingAdditional = await prisma.adicional.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingAdditional) {
      return res.status(404).json({ message: 'Adicional não encontrado' });
    }

    let imagemUrl = existingAdditional.imagemUrl;
    if (req.file) {
      const streamUpload = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({ folder: 'additionals' }, (error, result) => {
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
        return res.status(400).json({ message: 'Nome do adicional não pode estar vazio' });
      }

      if (nome.length > 100) {
        return res.status(400).json({ message: 'Nome deve ter no máximo 100 caracteres' });
      }

      const duplicateAdditional = await prisma.adicional.findFirst({
        where: {
          nome: nome.trim(),
          lojaId: req.lojaId,
          id: { not: parseInt(id) }
        }
      });

      if (duplicateAdditional) {
        return res.status(409).json({ message: 'Já existe outro adicional com este nome' });
      }

      updateData.nome = nome.trim();
    }

    if (valor !== undefined) {
      const parsedValue = valor === null || valor === '' ? 0 : Number(valor);
      if (Number.isNaN(parsedValue) || parsedValue < 0) {
        return res.status(400).json({ message: 'Valor inválido' });
      }
      updateData.valor = parsedValue;
    }

    if (ativo !== undefined) {
      updateData.ativo = Boolean(ativo);
    }

    if (categoriaId !== undefined) {
      updateData.categoriaId = categoriaId ? parseInt(categoriaId) : null;
    }

    const additional = await prisma.adicional.update({
      where: { id: parseInt(id) },
      data: updateData,
      include: {
        categoria: true
      }
    });

    const transformedAdditional = {
      id: additional.id,
      name: additional.nome,
      value: Number(additional.valor),
      imageUrl: additional.imagemUrl,
      isActive: additional.ativo,
      categoryId: additional.categoriaId,
      category: additional.categoria ? {
        id: additional.categoria.id,
        name: additional.categoria.nome
      } : null,
      createdAt: additional.criadoEm,
      updatedAt: additional.atualizadoEm
    };

    res.json(transformedAdditional);
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.delete('/:id', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const existingAdditional = await prisma.adicional.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingAdditional) {
      return res.status(404).json({ message: 'Adicional não encontrado' });
    }

    await prisma.adicional.delete({
      where: { id: parseInt(id) }
    });

    const transformedAdditional = {
      id: existingAdditional.id,
      name: existingAdditional.nome,
      value: Number(existingAdditional.valor),
      imageUrl: existingAdditional.imagemUrl,
      isActive: existingAdditional.ativo,
      createdAt: existingAdditional.criadoEm,
      updatedAt: existingAdditional.atualizadoEm
    };

    res.json({ message: 'Adicional deletado com sucesso', deletedAdditional: transformedAdditional });
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

router.patch('/:id/toggle', authenticateToken, authorize('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const existingAdditional = await prisma.adicional.findFirst({
      where: { id: parseInt(id), lojaId: req.lojaId }
    });

    if (!existingAdditional) {
      return res.status(404).json({ message: 'Adicional não encontrado' });
    }

    const additional = await prisma.adicional.update({
      where: { id: parseInt(id) },
      data: { ativo: !existingAdditional.ativo }
    });

    const transformedAdditional = {
      id: additional.id,
      name: additional.nome,
      value: Number(additional.valor),
      imageUrl: additional.imagemUrl,
      isActive: additional.ativo,
      createdAt: additional.criadoEm,
      updatedAt: additional.atualizadoEm
    };

    const status = additional.ativo ? 'ativado' : 'desativado';
    res.json({ message: `Adicional ${status} com sucesso`, additional: transformedAdditional });
  } catch (error) {
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

module.exports = router;
