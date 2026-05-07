const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');
const multer = require('multer');
const cloudinary = require('../services/cloudinary');
const streamifier = require('streamifier');
const DESCRIPTION_MAX_LENGTH = 150;

// Usar armazenamento em memória para processar upload
const upload = multer({ storage: multer.memoryStorage() });

// Função helper para transformar produto do Prisma para o formato do frontend
const transformProduct = (product) => {
    return {
        id: product.id,
        name: product.nome,
        description: product.descricao || '',
        price: product.preco,
        categoryId: product.categoriaId,
        isActive: product.ativo,
        isFeatured: product.destaque || false,
        receiveComplements: product.recebeComplementos || false,
        quantidadeComplementos: product.quantidadeComplementos ?? 0,
        receiveFlavors: product.recebeSabores || false,
        receiveAdditionals: product.recebeAdicionais || false,
        activeDays: product.diasAtivos || null,
        flavorCategories: (product.categorias_sabor || []).map(pcs => ({
            categoryId: pcs.categoriaSaborId,
            categoryName: pcs.categoriaSabor?.nome || '',
            quantity: pcs.quantidade
        })),
        additionalCategories: (product.categorias_adicional || []).map(pca => ({
            categoryId: pca.categoriaAdicionalId,
            categoryName: pca.categoriaAdicional?.nome || '',
            quantity: pca.quantidade
        })),
        createdAt: product.criadoEm || new Date(),
        updatedAt: product.atualizadoEm || new Date(),
        category: product.categoria ? {
            id: product.categoria.id,
            name: product.categoria.nome
        } : null,
        images: (product.imagens_produto || []).map(img => ({
            id: img.id,
            url: img.url,
            productId: img.produtoId
        })),
        mainImage: product.imagens_produto?.[0]?.url || null
    };
};

// ========== ROTAS ESPECÍFICAS ==========

// Rota para listar todas as categorias
router.get('/categories', async (req, res) => {
    console.log(`📂 GET /api/products/categories: Listando categorias (Loja ID: ${req.lojaId})`);
    try {
        // 🌟 MULTI-TENANT: Busca apenas categorias desta loja, ordenadas por ordem
        const categories = await prisma.categoria_produto.findMany({
            where: { lojaId: req.lojaId },
            orderBy: { ordem: 'asc' }
        });
        
        const transformedCategories = categories.map(cat => ({
            id: cat.id,
            name: cat.nome,
            ordem: cat.ordem || 0,
            isActive: cat.ativo !== false,
        }));
        console.log(`✅ Categorias listadas: ${categories.length} encontradas.`);
        res.status(200).json(transformedCategories);
    } catch (err) {
        console.error('❌ Erro ao buscar categorias:', err.message);
        res.status(500).json({ message: 'Erro ao buscar categorias.', error: err.message });
    }
});

// Rota para adicionar uma nova categoria
router.post('/categories/add', authenticateToken, authorize('admin'), async (req, res) => {
    const { nome } = req.body;
    console.log(`✨ POST /api/products/categories/add: Adicionando categoria (Loja ID: ${req.lojaId})`);
    
    if (!nome || !nome.trim()) {
        return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
    }
    try {
        // 🌟 MULTI-TENANT: Verifica duplicação apenas DENTRO da mesma loja
        const existingCategory = await prisma.categoria_produto.findFirst({
            where: { 
                nome: nome.trim(),
                lojaId: req.lojaId 
            }
        });
        
        if (existingCategory) {
            return res.status(409).json({ message: 'Já existe uma categoria com este nome nesta loja.' });
        }

        // Busca a maior ordem atual para definir a ordem da nova categoria
        const maxOrder = await prisma.categoria_produto.findFirst({
            where: { lojaId: req.lojaId },
            orderBy: { ordem: 'desc' },
            select: { ordem: true }
        });
        
        const newOrder = (maxOrder?.ordem || 0) + 1;

        const newCategory = await prisma.categoria_produto.create({
            data: { 
                nome: nome.trim(),
                lojaId: req.lojaId, // 🌟 MULTI-TENANT: Vincula à loja atual
                ordem: newOrder,
                ativo: true,
            },
        });
        
        res.status(201).json({ id: newCategory.id, name: newCategory.nome, ordem: newCategory.ordem, isActive: newCategory.ativo !== false });
    } catch (err) {
        console.error('❌ Erro ao adicionar categoria:', err.message);
        res.status(500).json({ message: 'Erro ao adicionar categoria.', error: err.message });
    }
});

// Rota para reordenar categorias (DEVE VIR ANTES de /categories/:id)
router.put('/categories/reorder', authenticateToken, authorize('admin'), async (req, res) => {
    const { categoryIds } = req.body; // Array de IDs na nova ordem
    console.log(`🔄 PUT /api/products/categories/reorder: Reordenando categorias (Loja ID: ${req.lojaId})`);
    
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
        return res.status(400).json({ message: 'Lista de IDs de categorias é obrigatória.' });
    }

    try {
        // Verifica se todas as categorias pertencem à loja atual
        const categories = await prisma.categoria_produto.findMany({
            where: { 
                id: { in: categoryIds.map(id => parseInt(id)) },
                lojaId: req.lojaId 
            }
        });

        if (categories.length !== categoryIds.length) {
            return res.status(400).json({ message: 'Uma ou mais categorias não foram encontradas ou não pertencem a esta loja.' });
        }

        // Atualiza a ordem de cada categoria
        const updatePromises = categoryIds.map((categoryId, index) => 
            prisma.categoria_produto.update({
                where: { id: parseInt(categoryId) },
                data: { ordem: index }
            })
        );

        await Promise.all(updatePromises);
        
        console.log(`✅ Categorias reordenadas com sucesso.`);
        res.status(200).json({ message: 'Categorias reordenadas com sucesso.' });
    } catch (err) {
        console.error('❌ Erro ao reordenar categorias:', err.message);
        res.status(500).json({ message: 'Erro ao reordenar categorias.', error: err.message });
    }
});

// Rota para atualizar uma categoria
router.put('/categories/:id', authenticateToken, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    const { nome, ativo } = req.body;
    const hasNome = typeof nome === 'string';
    const hasAtivo = typeof ativo === 'boolean';
    
    if (!hasNome && !hasAtivo) {
        return res.status(400).json({ message: 'Informe ao menos um campo para atualização.' });
    }

    try {
        // 🌟 MULTI-TENANT: Garante que a categoria pertence à loja atual antes de atualizar
        const existingCategory = await prisma.categoria_produto.findFirst({
            where: { id: parseInt(id), lojaId: req.lojaId }
        });

        if (!existingCategory) return res.status(404).json({ message: 'Categoria não encontrada.' });

        if (hasNome) {
            if (!nome.trim()) return res.status(400).json({ message: 'Nome da categoria é obrigatório.' });
            const duplicateCategory = await prisma.categoria_produto.findFirst({
                where: {
                    nome: nome.trim(),
                    lojaId: req.lojaId,
                    id: { not: parseInt(id) }
                }
            });

            if (duplicateCategory) return res.status(409).json({ message: 'Já existe outra categoria com este nome.' });
        }

        const updateData = {};
        if (hasNome) updateData.nome = nome.trim();
        if (hasAtivo) updateData.ativo = Boolean(ativo);
        const updatedCategory = await prisma.categoria_produto.update({
            where: { id: parseInt(id) },
            data: updateData
        });

        res.status(200).json({ id: updatedCategory.id, name: updatedCategory.nome, ordem: updatedCategory.ordem, isActive: updatedCategory.ativo !== false });
    } catch (err) {
        console.error(`❌ Erro ao atualizar categoria:`, err.message);
        res.status(500).json({ message: 'Erro ao atualizar categoria.', error: err.message });
    }
});

// Rota para deletar uma categoria
router.delete('/categories/:id', authenticateToken, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    try {
        // 🌟 MULTI-TENANT: Garante que a categoria é desta loja
        const existingCategory = await prisma.categoria_produto.findFirst({
            where: { id: parseInt(id), lojaId: req.lojaId },
            include: { produtos: { select: { id: true } } }
        });

        if (!existingCategory) return res.status(404).json({ message: 'Categoria não encontrada.' });

        if (existingCategory.produtos && existingCategory.produtos.length > 0) {
            return res.status(400).json({ 
                message: `Não é possível deletar. Esta categoria possui ${existingCategory.produtos.length} produto(s) associado(s).` 
            });
        }

        await prisma.categoria_produto.delete({
            where: { id: parseInt(id) }
        });

        res.status(200).json({ message: 'Categoria deletada com sucesso.' });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao deletar categoria.', error: err.message });
    }
});

// Rota para buscar produtos por categoria
router.get('/category/:categoriaId', async (req, res) => {
    const { categoriaId } = req.params;
    try {
        // 🌟 MULTI-TENANT: Filtra pela loja além da categoria
        const products = await prisma.produto.findMany({
            where: {
                categoriaId: parseInt(categoriaId),
                lojaId: req.lojaId
            },
            include: {
                categoria: true,
                imagens_produto: { orderBy: { id: 'asc' } },
                opcoes_produto: { include: { valores_opcao: true } },
                categorias_sabor: { include: { categoriaSabor: true } },
                categorias_adicional: { include: { categoriaAdicional: true } }
            },
        });
        
        if (products.length === 0) return res.status(404).json({ message: "Nenhum produto encontrado para esta categoria." });
        
        const transformedProducts = products.map(product => {
            const transformed = transformProduct(product);
            if (product.opcoes_produto) transformed.options = product.opcoes_produto;
            return transformed;
        });
        
        res.status(200).json(transformedProducts);
    } catch (err) {
        res.status(500).json({ message: "Erro ao buscar produtos por categoria.", error: err.message });
    }
});

// Rota para adicionar um novo produto
router.post('/add', authenticateToken, authorize('admin'), upload.array('images', 5), async (req, res) => {
    const { nome, preco, descricao, categoriaId, isFeatured, receiveComplements, quantidadeComplementos, receiveFlavors, flavorCategories, receiveAdditionals, additionalCategories, diasAtivos } = req.body;
    const imageFiles = req.files || [];

    if ((descricao || '').length > DESCRIPTION_MAX_LENGTH) {
        return res.status(400).json({ message: `A descrição deve ter no máximo ${DESCRIPTION_MAX_LENGTH} caracteres.` });
    }
    
    try {
        const imagesData = [];
        for (const file of imageFiles) {
            const streamUpload = () => {
                return new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream({ folder: 'produtos' }, (error, result) => {
                        if (result) resolve({ url: result.secure_url });
                        else reject(error);
                    });
                    streamifier.createReadStream(file.buffer).pipe(stream);
                });
            };
            const uploadResult = await streamUpload();
            imagesData.push(uploadResult);
        }
        
        let flavorCategoriesData = [];
        if (receiveFlavors === 'true' || receiveFlavors === true) {
            try {
                const parsedFlavorCategories = typeof flavorCategories === 'string' ? JSON.parse(flavorCategories) : flavorCategories;
                if (Array.isArray(parsedFlavorCategories) && parsedFlavorCategories.length > 0) {
                    flavorCategoriesData = parsedFlavorCategories.map(fc => ({
                        categoriaSaborId: parseInt(fc.categoryId),
                        quantidade: parseInt(fc.quantity) || 1
                    })).filter(fc => !isNaN(fc.categoriaSaborId));
                }
            } catch (e) {}
        }
        
        let additionalCategoriesData = [];
        if (receiveAdditionals === 'true' || receiveAdditionals === true) {
            try {
                const parsedAdditionalCategories = typeof additionalCategories === 'string' ? JSON.parse(additionalCategories) : additionalCategories;
                if (Array.isArray(parsedAdditionalCategories) && parsedAdditionalCategories.length > 0) {
                    additionalCategoriesData = parsedAdditionalCategories.map(ac => ({
                        categoriaAdicionalId: parseInt(ac.categoryId),
                        quantidade: parseInt(ac.quantity) || 1
                    })).filter(ac => !isNaN(ac.categoriaAdicionalId));
                }
            } catch (e) {}
        }
        
        const newProduct = await prisma.produto.create({
            data: {
                lojaId: req.lojaId, // 🌟 MULTI-TENANT: Atribui o produto à loja logada
                nome,
                preco: parseFloat(preco),
                descricao,
                categoriaId: parseInt(categoriaId),
                destaque: isFeatured === 'true' || isFeatured === true,
                recebeComplementos: receiveComplements === 'true' || receiveComplements === true,
                quantidadeComplementos: receiveComplements === 'true' || receiveComplements === true ? parseInt(quantidadeComplementos) || 0 : 0,
                recebeSabores: receiveFlavors === 'true' || receiveFlavors === true,
                recebeAdicionais: receiveAdditionals === 'true' || receiveAdditionals === true,
                diasAtivos: diasAtivos || null,
                imagens_produto: imagesData.length > 0 ? { create: imagesData } : undefined,
                categorias_sabor: flavorCategoriesData.length > 0 ? { create: flavorCategoriesData } : undefined,
                categorias_adicional: additionalCategoriesData.length > 0 ? { create: additionalCategoriesData } : undefined
            },
            include: { 
                imagens_produto: true,
                categorias_sabor: { include: { categoriaSabor: true } },
                categorias_adicional: { include: { categoriaAdicional: true } },
                categoria: true
            }
        });
        
        res.status(201).json({ message: 'Produto adicionado com sucesso.', product: transformProduct(newProduct) });
    } catch (err) {
        console.error('❌ Erro ao adicionar produto:', err.message);
        res.status(500).json({ message: 'Erro ao adicionar produto.', error: err.message });
    }
});

// Rota para atualizar um produto existente
router.put('/update/:id', authenticateToken, authorize('admin'), upload.array('images', 5), async (req, res) => {
    const { id } = req.params;
    const { nome, preco, descricao, categoriaId, ativo, isFeatured, receiveComplements, quantidadeComplementos, receiveFlavors, flavorCategories, receiveAdditionals, additionalCategories, diasAtivos } = req.body;
    const imageFiles = req.files || [];

    if ((descricao || '').length > DESCRIPTION_MAX_LENGTH) {
        return res.status(400).json({ message: `A descrição deve ter no máximo ${DESCRIPTION_MAX_LENGTH} caracteres.` });
    }
    
    console.log('🔍 [UPDATE PRODUCT] Debug - additionalCategories recebido:', additionalCategories);
    console.log('🔍 [UPDATE PRODUCT] Debug - receiveAdditionals:', receiveAdditionals);
    console.log('🔍 [UPDATE PRODUCT] Debug - tipo de additionalCategories:', typeof additionalCategories);
    
    try {
        // 🌟 MULTI-TENANT: Garante que o Admin só edite produtos da PRÓPRIA loja
        const existingProduct = await prisma.produto.findFirst({
            where: { id: parseInt(id), lojaId: req.lojaId },
            include: { imagens_produto: true, categorias_sabor: true, categorias_adicional: true }
        });
        
        if (!existingProduct) return res.status(404).json({ message: 'Produto não encontrado.' });
        
        const updateData = {};
        if (nome !== undefined && nome !== null && nome !== '') updateData.nome = nome;
        if (preco !== undefined && preco !== null && preco !== '') {
            const parsedPreco = parseFloat(preco);
            if (!isNaN(parsedPreco)) updateData.preco = parsedPreco;
        } else updateData.preco = existingProduct.preco;
        
        if (descricao !== undefined && descricao !== null) updateData.descricao = descricao;
        if (categoriaId !== undefined && categoriaId !== null && categoriaId !== '') {
            const parsedCategoriaId = parseInt(categoriaId);
            if (!isNaN(parsedCategoriaId)) updateData.categoriaId = parsedCategoriaId;
        }
        
        if (ativo !== undefined && ativo !== null) updateData.ativo = ativo === 'true' || ativo === true;
        if (isFeatured !== undefined && isFeatured !== null) updateData.destaque = isFeatured === 'true' || isFeatured === true;
        if (receiveComplements !== undefined && receiveComplements !== null) updateData.recebeComplementos = receiveComplements === 'true' || receiveComplements === true;
        
        if (quantidadeComplementos !== undefined && quantidadeComplementos !== null && quantidadeComplementos !== '') {
            const parsedQtd = parseInt(quantidadeComplementos);
            if (!isNaN(parsedQtd)) updateData.quantidadeComplementos = parsedQtd;
        } else if (receiveComplements === 'false' || receiveComplements === false) {
            updateData.quantidadeComplementos = 0;
        }
        
        if (receiveFlavors !== undefined && receiveFlavors !== null) updateData.recebeSabores = receiveFlavors === 'true' || receiveFlavors === true;

        if (receiveAdditionals !== undefined && receiveAdditionals !== null) {
            updateData.recebeAdicionais = receiveAdditionals === 'true' || receiveAdditionals === true;
        }
        
        if (diasAtivos !== undefined) {
            updateData.diasAtivos = diasAtivos || null;
        }
        
        if (imageFiles.length > 0) {
            await prisma.imagem_produto.deleteMany({ where: { produtoId: parseInt(id) } });
            const imagesData = [];
            for (const file of imageFiles) {
                const streamUpload = () => {
                    return new Promise((resolve, reject) => {
                        const stream = cloudinary.uploader.upload_stream({ folder: 'produtos' }, (error, result) => {
                            if (result) resolve(result.secure_url);
                            else reject(error);
                        });
                        streamifier.createReadStream(file.buffer).pipe(stream);
                    });
                };
                const uploadResult = await streamUpload();
                imagesData.push({ url: uploadResult });
            }
            updateData.imagens_produto = { create: imagesData };
        }
        
        const updatedProduct = await prisma.$transaction(async (tx) => {
            if (receiveFlavors !== undefined) {
                await tx.produto_categoria_sabor.deleteMany({ where: { produtoId: parseInt(id) } });
            }
            
            if (receiveAdditionals !== undefined) {
                await tx.produto_categoria_adicional.deleteMany({ where: { produtoId: parseInt(id) } });
            }
            
            await tx.produto.update({
                where: { id: parseInt(id) },
                data: updateData
            });
            
            if (receiveFlavors === 'true' || receiveFlavors === true) {
                try {
                    const parsedFlavorCategories = typeof flavorCategories === 'string' ? JSON.parse(flavorCategories) : flavorCategories;
                    if (Array.isArray(parsedFlavorCategories) && parsedFlavorCategories.length > 0) {
                        const flavorCategoriesData = parsedFlavorCategories.map(fc => ({
                            produtoId: parseInt(id),
                            categoriaSaborId: parseInt(fc.categoryId),
                            quantidade: parseInt(fc.quantity) || 1
                        })).filter(fc => !isNaN(fc.categoriaSaborId));
                        
                        if (flavorCategoriesData.length > 0) {
                            await tx.produto_categoria_sabor.createMany({ data: flavorCategoriesData });
                        }
                    }
                } catch (e) {}
            }
            
            if (receiveAdditionals === 'true' || receiveAdditionals === true) {
                try {
                    console.log('🔍 [UPDATE PRODUCT] Processando additionalCategories...');
                    const parsedAdditionalCategories = typeof additionalCategories === 'string' ? JSON.parse(additionalCategories) : (additionalCategories || []);
                    console.log('🔍 [UPDATE PRODUCT] additionalCategories parseado:', parsedAdditionalCategories);
                    
                    if (Array.isArray(parsedAdditionalCategories)) {
                        if (parsedAdditionalCategories.length > 0) {
                            const additionalCategoriesData = parsedAdditionalCategories.map(ac => ({
                                produtoId: parseInt(id),
                                categoriaAdicionalId: parseInt(ac.categoryId),
                                quantidade: parseInt(ac.quantity) || 1
                            })).filter(ac => !isNaN(ac.categoriaAdicionalId));
                            
                            console.log('🔍 [UPDATE PRODUCT] additionalCategoriesData preparado:', additionalCategoriesData);
                            
                            if (additionalCategoriesData.length > 0) {
                                await tx.produto_categoria_adicional.createMany({ data: additionalCategoriesData });
                                console.log('✅ [UPDATE PRODUCT] additionalCategories salvo com sucesso!');
                            } else {
                                console.log('⚠️ [UPDATE PRODUCT] additionalCategoriesData está vazio após filtro');
                            }
                        } else {
                            console.log('ℹ️ [UPDATE PRODUCT] Array de additionalCategories está vazio - categorias foram removidas');
                        }
                    } else {
                        console.log('⚠️ [UPDATE PRODUCT] parsedAdditionalCategories não é um array válido');
                    }
                } catch (e) {
                    console.error('❌ [UPDATE PRODUCT] Erro ao processar additionalCategories:', e.message, e.stack);
                }
            } else {
                console.log('ℹ️ [UPDATE PRODUCT] receiveAdditionals é false, não processando additionalCategories');
            }
        });
        
        const completeProduct = await prisma.produto.findFirst({
            where: { id: parseInt(id), lojaId: req.lojaId },
            include: {
                imagens_produto: true,
                categorias_sabor: { include: { categoriaSabor: true } },
                categorias_adicional: { include: { categoriaAdicional: true } },
                categoria: true
            }
        });

        if (!completeProduct) {
            return res.status(404).json({ message: 'Produto não encontrado.' });
        }
        
        res.status(200).json({ message: 'Produto atualizado com sucesso.', product: transformProduct(completeProduct) });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao atualizar produto.', error: err.message });
    }
});

// Rota para deletar um produto
router.delete('/delete/:id', authenticateToken, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    try {
        // 🌟 MULTI-TENANT: Verifica se o produto pertence à loja antes de deletar
        const product = await prisma.produto.findFirst({
            where: { id: parseInt(id), lojaId: req.lojaId }
        });

        if (!product) return res.status(404).json({ message: 'Produto não encontrado.' });

        await prisma.produto.delete({ where: { id: parseInt(id) } });
        res.status(200).json({ message: 'Produto deletado com sucesso.' });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao deletar produto.', error: err.message });
    }
});

// ========== ROTAS GENÉRICAS ==========

// Rota para listar todos os produtos
router.get('/', async (req, res) => {
    console.log(`📦 GET /api/products: Listando produtos (Loja ID: ${req.lojaId})`);
    try {
        // 🌟 MULTI-TENANT: Lista APENAS os produtos da loja acessada
        const products = await prisma.produto.findMany({
            where: { lojaId: req.lojaId },
            include: { 
                imagens_produto: { orderBy: { id: 'asc' } }, 
                categoria: true,
                categorias_sabor: { include: { categoriaSabor: true } },
                categorias_adicional: { include: { categoriaAdicional: true } }
            }
        });
        
        const transformedProducts = products.map(product => transformProduct(product));
        res.json(transformedProducts);
    } catch (err) {
        res.status(500).json({ message: 'Erro ao buscar produtos.', error: err.message });
    }
});

// Rota para buscar um produto específico por ID
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 🌟 MULTI-TENANT: Busca o produto, mas apenas se ele pertencer a esta loja
        const product = await prisma.produto.findFirst({
            where: { 
                id: parseInt(id),
                lojaId: req.lojaId 
            },
            include: { 
                imagens_produto: { orderBy: { id: 'asc' } }, 
                categoria: true,
                categorias_sabor: { include: { categoriaSabor: true } },
                categorias_adicional: { include: { categoriaAdicional: true } }
            }
        });

        if (!product) return res.status(404).json({ message: 'Produto não encontrado.' });

        res.json(transformProduct(product));
    } catch (err) {
        res.status(500).json({ message: 'Erro ao buscar produto.', error: err.message });
    }
});

module.exports = router;