const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken } = require('./auth');

// Rota para adicionar um produto ao carrinho
router.post('/add', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { produtoId, quantity, complementIds, selectedFlavors, additionalItems, observacao } = req.body;

    console.log(`➡️ [POST /api/cart/add] Requisição para adicionar item. Usuário ID: ${userId}, Produto ID: ${produtoId}, Quantidade: ${quantity}, Complementos: ${JSON.stringify(complementIds)}, Adicionais: ${JSON.stringify(additionalItems)}, Sabores: ${JSON.stringify(selectedFlavors)}.`);

    if (!produtoId || !quantity) {
        console.warn('⚠️ [POST /api/cart/add] Falha ao adicionar item: ID do produto ou quantidade ausente.');
        return res.status(400).json({ message: 'ID do produto e quantidade são obrigatórios.' });
    }

    try {
        const produto = await prisma.produto.findFirst({
            where: { id: produtoId, lojaId: req.lojaId }
        });

        if (!produto) {
            return res.status(404).json({ message: 'Produto não encontrado.' });
        }

        let cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
            include: { itens: true }
        });

        if (!cart) {
            console.log(`🛒 [POST /api/cart/add] Carrinho não encontrado para o usuário ${userId}. Criando novo carrinho.`);
            cart = await prisma.carrinho.create({
                data: {
                    lojaId: req.lojaId,
                    usuarioId: userId,
                },
            });
        } else if (cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Verificar se existe item idêntico (mesmo produto, mesmos complementos, mesmos adicionais E mesmos sabores)
        const complementIdsArray = complementIds || [];
        const additionalItemsArray = Array.isArray(additionalItems) ? additionalItems : [];
        const selectedFlavorsObj = selectedFlavors || {};
        const existingCartItems = await prisma.item_carrinho.findMany({
            where: {
                carrinhoId: cart.id,
                produtoId: produtoId,
            },
            include: {
                complementos: true,
                adicionais: true,
                sabores: true
            }
        });

        // Verificar se os complementos são idênticos
        // Normalizar ambos objetos para comparação (converter chaves para strings)
        const normalizeFlavors = (flavors) => {
            const normalized = {};
            Object.keys(flavors || {}).forEach(key => {
                normalized[String(key)] = flavors[key];
            });
            return normalized;
        };

        // Verificar se os adicionais são idênticos
        const normalizeAdditionals = (arr) => {
            if (!Array.isArray(arr)) return [];
            return arr
                .map((a) => ({ id: Number(a.id ?? a.adicionalId), quantity: Number(a.quantity ?? a.quantidade ?? 0) }))
                .filter((a) => !isNaN(a.id) && a.id > 0 && !isNaN(a.quantity) && a.quantity > 0)
                .sort((a, b) => a.id - b.id);
        };

        const requestedAdditionals = normalizeAdditionals(additionalItemsArray);
        // Extrair IDs dos sabores do objeto selectedFlavorsObj
        const flavorIdsArray = [];
        Object.values(selectedFlavorsObj || {}).forEach(ids => {
            if (Array.isArray(ids)) {
                flavorIdsArray.push(...ids.map(id => Number(id)));
            } else {
                flavorIdsArray.push(Number(ids));
            }
        });
        flavorIdsArray.sort((a, b) => a - b);

        const requestedObservacao = (observacao || '').trim();

        const findMatchingItem = () => {
            for (const item of existingCartItems) {
                const hasSameComplements =
                    item.complementos.length === complementIdsArray.length &&
                    item.complementos.every(c => complementIdsArray.includes(c.complementoId));

                if (!hasSameComplements) continue;

                const existingAdditionals = normalizeAdditionals(item.adicionais);
                const hasSameAdditionals = JSON.stringify(existingAdditionals) === JSON.stringify(requestedAdditionals);
                if (!hasSameAdditionals) continue;

                const itemFlavorIds = (item.sabores || []).map(s => Number(s.saborId)).sort((a, b) => a - b);
                const hasSameFlavors = JSON.stringify(itemFlavorIds) === JSON.stringify(flavorIdsArray);
                if (!hasSameFlavors) continue;

                const existingObservacao = (item?.opcoesSelecionadas?.observacao || '').trim();
                if (existingObservacao !== requestedObservacao) continue;

                return item;
            }
            return null;
        };

        const matchingCartItem = findMatchingItem();

        if (matchingCartItem) {
            // Atualizar quantidade do item existente
            const updatedItem = await prisma.item_carrinho.update({
                where: { id: matchingCartItem.id },
                data: { quantidade: matchingCartItem.quantidade + quantity },
            });
            console.log(`🔄 [POST /api/cart/add] Quantidade do item no carrinho atualizada. Item ID: ${updatedItem.id}`);
            return res.status(200).json({ message: 'Quantidade do item atualizada com sucesso.', cartItem: updatedItem });
        } else {
            // Preparar opcoesSelecionadas sem os sabores antigos para não poluir
            const opcoesSelecionadas = {};
            // Mantemos selectedFlavors no snapshot do pedido depois, mas no carrinho o principal agora é item_carrinho_sabor
            // Podemos manter em opcoesSelecionadas.selectedFlavors por retrocompatibilidade temporária se quisermos, mas o ideal é a tabela.
            if (selectedFlavorsObj && Object.keys(selectedFlavorsObj).length > 0) {
                opcoesSelecionadas.selectedFlavors = selectedFlavorsObj; // Mantido como backup/snapshot
            }
            if (requestedObservacao) {
                opcoesSelecionadas.observacao = requestedObservacao;
            }

            // Criar novo item no carrinho
            const newCartItem = await prisma.item_carrinho.create({
                data: {
                    carrinhoId: cart.id,
                    produtoId: produtoId,
                    quantidade: quantity,
                    opcoesSelecionadas: Object.keys(opcoesSelecionadas).length > 0 ? opcoesSelecionadas : undefined,
                },
            });

            // Adicionar complementos ao item do carrinho, se houver
            if (complementIdsArray && complementIdsArray.length > 0) {
                const complementData = complementIdsArray.map(complementId => ({
                    itemCarrinhoId: newCartItem.id,
                    complementoId: complementId,
                }));

                await prisma.item_carrinho_complemento.createMany({
                    data: complementData,
                });

                console.log(`🍓 [POST /api/cart/add] ${complementData.length} complementos adicionados ao item do carrinho.`);
            }

            // Adicionar adicionais ao item do carrinho, se houver
            if (requestedAdditionals.length > 0) {
                const additionalData = requestedAdditionals.map(a => ({
                    itemCarrinhoId: newCartItem.id,
                    adicionalId: a.id,
                    quantidade: a.quantity,
                }));

                await prisma.item_carrinho_adicional.createMany({
                    data: additionalData,
                });

                console.log(`➕ [POST /api/cart/add] ${additionalData.length} adicionais adicionados ao item do carrinho.`);
            }

            // Adicionar sabores ao item do carrinho, se houver
            if (flavorIdsArray.length > 0) {
                const saborData = flavorIdsArray.map(saborId => ({
                    itemCarrinhoId: newCartItem.id,
                    saborId: saborId,
                }));

                await prisma.item_carrinho_sabor.createMany({
                    data: saborData,
                });

                console.log(`🍦 [POST /api/cart/add] ${saborData.length} sabores adicionados ao item do carrinho.`);
            }

            console.log(`✅ [POST /api/cart/add] Novo item adicionado ao carrinho. Item ID: ${newCartItem.id}`);
            return res.status(201).json({ message: 'Item adicionado ao carrinho com sucesso.', cartItem: newCartItem });
        }
    } catch (err) {
        console.error('❌ [POST /api/cart/add] Erro ao adicionar produto ao carrinho:', err.message);
        res.status(500).json({ message: 'Erro ao adicionar produto ao carrinho.', error: err.message });
    }
});

// Rota para buscar o carrinho do usuário
router.get('/', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    console.log(`🔍 [GET /api/cart] Requisição para buscar o carrinho do usuário ID: ${userId}.`);

    try {
        const cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
            include: {
                itens: {
                    include: {
                        produto: {
                            include: {
                                imagens_produto: true
                            }
                        },
                        complementos: {
                            include: {
                                complemento: true
                            }
                        },
                        adicionais: {
                            include: {
                                adicional: true
                            }
                        },
                        sabores: {
                            include: {
                                sabor: true
                            }
                        }
                    }
                }
            }
        });

        if (cart && cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        if (!cart) {
            console.warn(`⚠️ [GET /api/cart] Carrinho não encontrado para o usuário ${userId}. Retornando carrinho vazio.`);
            return res.status(200).json({ items: [], cartTotal: 0 });
        }

        const cartItemsWithTotals = cart.itens.map(item => {
            // Verificar se é produto personalizado
            let itemPrice = item.produto.preco; // Preço padrão
            
            if (item.opcoesSelecionadas) {
                // Verificar açaí personalizado
                if (item.opcoesSelecionadas.customAcai) {
                    itemPrice = item.opcoesSelecionadas.customAcai.value;
                    console.log(`🎨 Açaí personalizado encontrado: ${item.produto.nome} - Valor customizado: R$ ${itemPrice}`);
                }
                // Verificar sorvete personalizado
                else if (item.opcoesSelecionadas.customSorvete) {
                    itemPrice = item.opcoesSelecionadas.customSorvete.value;
                    console.log(`🍦 Sorvete personalizado encontrado: ${item.produto.nome} - Valor customizado: R$ ${itemPrice}`);
                }
                // Verificar outros produtos personalizados
                else if (item.opcoesSelecionadas.customProduct) {
                    itemPrice = item.opcoesSelecionadas.customProduct.value;
                    console.log(`🎨 Produto personalizado encontrado: ${item.produto.nome} - Valor customizado: R$ ${itemPrice}`);
                }
            }
            
            // Mapear complementos
            const complements = item.complementos ? item.complementos.map(c => ({
                id: c.complemento.id,
                name: c.complemento.nome,
                imageUrl: c.complemento.imagemUrl,
                isActive: c.complemento.ativo
            })) : [];

            // Mapear sabores
            const saboresMapeados = item.sabores ? item.sabores.map(s => ({
                id: s.sabor.id,
                name: s.sabor.nome,
                imageUrl: s.sabor.imagemUrl,
                isActive: s.sabor.ativo
            })) : [];

            // Mapear adicionais e somar valores
            const additionals = item.adicionais ? item.adicionais.map(a => ({
                id: a.adicional.id,
                name: a.adicional.nome,
                value: Number(a.adicional.valor),
                quantity: a.quantidade ?? 1,
                imageUrl: a.adicional.imagemUrl,
                isActive: a.adicional.ativo
            })) : [];

            const additionalsTotal = additionals.reduce((acc, a) => acc + ((Number(a.value) || 0) * (Number(a.quantity) || 0)), 0);
            
            // Transformar campos do português para inglês
            return {
                id: item.id,
                quantity: item.quantidade,
                createdAt: item.criadoEm,
                cartId: item.carrinhoId,
                productId: item.produtoId,
                selectedOptions: item.opcoesSelecionadas,
                observacao: item.opcoesSelecionadas?.observacao || '',
                complements: complements,
                additionals: additionals,
                flavors: saboresMapeados,
                totalPrice: item.quantidade * (Number(itemPrice) + additionalsTotal),
                product: {
                    id: item.produto.id,
                    name: item.produto.nome,
                    price: Number(itemPrice),
                    description: item.produto.descricao,
                    isActive: item.produto.ativo,
                    createdAt: item.produto.criadoEm,
                    categoryId: item.produto.categoriaId,
                    images: item.produto.imagens_produto ? item.produto.imagens_produto.map(img => ({
                        id: img.id,
                        url: img.url,
                        altText: img.textoAlternativo,
                        productId: img.produtoId
                    })) : []
                }
            };
        });

        const cartTotal = cartItemsWithTotals.reduce((total, item) => total + item.totalPrice, 0);

        console.log(`✅ [GET /api/cart] Carrinho do usuário ${userId} encontrado com ${cart.itens.length} itens.`);
        res.status(200).json({
            items: cartItemsWithTotals,
            cartTotal: cartTotal
        });
    } catch (err) {
        console.error(`❌ [GET /api/cart] Erro ao buscar o carrinho do usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao buscar o carrinho.', error: err.message });
    }
});

// Rota para atualizar a quantidade de um item no carrinho
router.put('/update/:cartItemId', authenticateToken, async (req, res) => {
    const { cartItemId } = req.params;
    const { quantity } = req.body;
    console.log(`🔄 [PUT /api/cart/update/${cartItemId}] Requisição para atualizar item. Item ID: ${cartItemId}, Nova Quantidade: ${quantity}.`);

    if (quantity === undefined) {
        console.warn('⚠️ [PUT /api/cart/update] Quantidade não fornecida.');
        return res.status(400).json({ message: 'A quantidade é obrigatória.' });
    }

    try {
        const item = await prisma.item_carrinho.findFirst({
            where: {
                id: parseInt(cartItemId),
                carrinho: {
                    usuarioId: req.user.id,
                    lojaId: req.lojaId
                }
            }
        });

        if (!item) {
            return res.status(404).json({ message: 'Item do carrinho não encontrado.' });
        }

        const updatedItem = await prisma.item_carrinho.update({
            where: { id: parseInt(cartItemId) },
            data: { quantidade: parseInt(quantity) },
        });
        console.log(`✅ [PUT /api/cart/update/${cartItemId}] Quantidade do item atualizada com sucesso. Item ID: ${updatedItem.id}`);
        res.status(200).json({ message: 'Quantidade do item atualizada com sucesso.', cartItem: updatedItem });
    } catch (err) {
        console.error(`❌ [PUT /api/cart/update/${cartItemId}] Erro ao atualizar a quantidade do item:`, err.message);
        res.status(500).json({ message: 'Erro ao atualizar a quantidade do item.', error: err.message });
    }
});

// Rota para remover um item do carrinho
router.delete('/remove/:cartItemId', authenticateToken, async (req, res) => {
    const { cartItemId } = req.params;
    console.log(`🗑️ [DELETE /api/cart/remove/${cartItemId}] Requisição para remover item. Item ID: ${cartItemId}.`);

    try {
        const item = await prisma.item_carrinho.findFirst({
            where: {
                id: parseInt(cartItemId),
                carrinho: {
                    usuarioId: req.user.id,
                    lojaId: req.lojaId
                }
            }
        });

        if (!item) {
            return res.status(404).json({ message: 'Item do carrinho não encontrado.' });
        }

        await prisma.item_carrinho.delete({
            where: { id: parseInt(cartItemId) },
        });
        console.log(`✅ [DELETE /api/cart/remove/${cartItemId}] Item removido do carrinho com sucesso.`);
        res.status(200).json({ message: 'Item removido do carrinho com sucesso.' });
    } catch (err) {
        console.error(`❌ [DELETE /api/cart/remove/${cartItemId}] Erro ao remover item do carrinho:`, err.message);
        res.status(500).json({ message: 'Erro ao remover o item do carrinho.', error: err.message });
    }
});

// Rota para esvaziar o carrinho
router.delete('/clear', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    console.log(`➡️ [DELETE /api/cart/clear] Requisição para esvaziar carrinho. Usuário ID: ${userId}.`);

    try {
        const cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
        });

        if (cart && cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        if (!cart) {
            console.warn(`⚠️ [DELETE /api/cart/clear] Carrinho não encontrado para o usuário ${userId}. Nada a ser esvaziado.`);
            return res.status(200).json({ message: 'Carrinho já está vazio.' });
        }

        await prisma.item_carrinho.deleteMany({
            where: { carrinhoId: cart.id },
        });

        console.log(`🧹 [DELETE /api/cart/clear] Carrinho do usuário ${userId} esvaziado com sucesso.`);
        res.status(200).json({ message: 'Carrinho esvaziado com sucesso.' });
    } catch (err) {
        console.error(`❌ [DELETE /api/cart/clear] Erro ao esvaziar o carrinho para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao esvaziar o carrinho.', error: err.message });
    }
});

// Rota para adicionar açaí personalizado ao carrinho
router.post('/add-custom-acai', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { value, selectedComplements, complementNames, quantity } = req.body;

    console.log(`➡️ [POST /api/cart/add-custom-acai] Requisição para adicionar açaí personalizado. Usuário ID: ${userId}, Valor: R$${value}, Quantidade: ${quantity}.`);

    if (!value || !quantity) {
        console.warn('⚠️ [POST /api/cart/add-custom-acai] Falha: Valor ou quantidade ausente.');
        return res.status(400).json({ message: 'Valor e quantidade são obrigatórios.' });
    }

    try {
        // Buscar o produto "Açaí Personalizado"
        const customAcaiProduct = await prisma.produto.findFirst({
            where: { nome: 'Açaí Personalizado', lojaId: req.lojaId }
        });

        if (!customAcaiProduct) {
            console.error('❌ [POST /api/cart/add-custom-acai] Produto "Açaí Personalizado" não encontrado.');
            return res.status(404).json({ message: 'Produto açaí personalizado não encontrado.' });
        }

        // Buscar ou criar carrinho
        let cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
            include: { itens: true }
        });

        if (!cart) {
            console.log(`🛒 [POST /api/cart/add-custom-acai] Criando novo carrinho para usuário ${userId}.`);
            cart = await prisma.carrinho.create({
                data: { lojaId: req.lojaId, usuarioId: userId },
            });
        } else if (cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Criar estrutura de opções personalizadas
        const opcoesSelecionadas = {
            customAcai: {
                value: value,
                selectedComplements: selectedComplements || [],
                complementNames: complementNames || []
            }
        };

        // Adicionar item do açaí personalizado ao carrinho
        // Cada açaí personalizado é único, então sempre criar novo item
        const cartItem = await prisma.item_carrinho.create({
            data: {
                carrinhoId: cart.id,
                produtoId: customAcaiProduct.id,
                quantidade: quantity,
                opcoesSelecionadas: opcoesSelecionadas
            }
        });

        console.log(`✅ [POST /api/cart/add-custom-acai] Açaí personalizado adicionado com sucesso. Item ID: ${cartItem.id}`);
        res.status(201).json({ 
            message: 'Açaí personalizado adicionado ao carrinho com sucesso.', 
            cartItem: cartItem 
        });

    } catch (err) {
        console.error(`❌ [POST /api/cart/add-custom-acai] Erro ao adicionar açaí personalizado para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao adicionar açaí personalizado ao carrinho.', error: err.message });
    }
});

// Rota genérica para adicionar produtos personalizados ao carrinho
router.post('/add-custom-produto', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { produtoName, value, selectedComplements, complementNames, quantity } = req.body;

    console.log(`➡️ [POST /api/cart/add-custom-produto] Requisição para adicionar ${produtoName}. Usuário ID: ${userId}, Valor: R$${value}, Quantidade: ${quantity}.`);

    if (!produtoName || !value || !quantity) {
        console.warn('⚠️ [POST /api/cart/add-custom-produto] Falha: Nome do produto, valor ou quantidade ausente.');
        return res.status(400).json({ message: 'Nome do produto, valor e quantidade são obrigatórios.' });
    }

    try {
        // Buscar o produto personalizado
        const customProduct = await prisma.produto.findFirst({
            where: { nome: produtoName, lojaId: req.lojaId }
        });

        if (!customProduct) {
            console.error(`❌ [POST /api/cart/add-custom-produto] Produto "${produtoName}" não encontrado.`);
            return res.status(404).json({ message: `Produto ${produtoName} não encontrado.` });
        }

        // Buscar ou criar carrinho
        let cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
            include: { itens: true }
        });

        if (!cart) {
            console.log(`🛒 [POST /api/cart/add-custom-produto] Criando novo carrinho para usuário ${userId}.`);
            cart = await prisma.carrinho.create({
                data: { lojaId: req.lojaId, usuarioId: userId },
            });
        } else if (cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Determinar o tipo de produto para o opcoesSelecionadas
        const produtoType = produtoName.toLowerCase().includes('açaí') ? 'customAcai' : 
                           produtoName.toLowerCase().includes('sorvete') ? 'customSorvete' : 'customProduct';

        // Criar estrutura de opções personalizadas
        const opcoesSelecionadas = {
            [produtoType]: {
                value: value,
                selectedComplements: selectedComplements || [],
                complementNames: complementNames || []
            }
        };

        // Adicionar item do produto personalizado ao carrinho
        // Cada produto personalizado é único, então sempre criar novo item
        const cartItem = await prisma.item_carrinho.create({
            data: {
                carrinhoId: cart.id,
                produtoId: customProduct.id,
                quantidade: quantity,
                opcoesSelecionadas: opcoesSelecionadas
            }
        });

        console.log(`✅ [POST /api/cart/add-custom-produto] ${produtoName} adicionado com sucesso. Item ID: ${cartItem.id}`);
        res.status(201).json({ 
            message: `${produtoName} adicionado ao carrinho com sucesso.`, 
            cartItem: cartItem 
        });

    } catch (err) {
        console.error(`❌ [POST /api/cart/add-custom-produto] Erro ao adicionar ${produtoName} para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: `Erro ao adicionar ${produtoName} ao carrinho.`, error: err.message });
    }
});

// Rota para adicionar açaí personalizado ao carrinho (mantida para compatibilidade)
router.post('/add-custom-acai', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { value, selectedComplements, complementNames, quantity } = req.body;

    console.log(`➡️ [POST /api/cart/add-custom-acai] Requisição para adicionar açaí personalizado. Usuário ID: ${userId}, Valor: R$${value}, Quantidade: ${quantity}.`);

    if (!value || !quantity) {
        console.warn('⚠️ [POST /api/cart/add-custom-acai] Falha: Valor ou quantidade ausente.');
        return res.status(400).json({ message: 'Valor e quantidade são obrigatórios.' });
    }

    try {
        // Buscar o produto "Açaí Personalizado"
        const customAcaiProduct = await prisma.produto.findFirst({
            where: { nome: 'Açaí Personalizado', lojaId: req.lojaId }
        });

        if (!customAcaiProduct) {
            console.error('❌ [POST /api/cart/add-custom-acai] Produto "Açaí Personalizado" não encontrado.');
            return res.status(404).json({ message: 'Produto açaí personalizado não encontrado.' });
        }

        // Buscar ou criar carrinho
        let cart = await prisma.carrinho.findUnique({
            where: { usuarioId: userId },
            include: { itens: true }
        });

        if (!cart) {
            console.log(`🛒 [POST /api/cart/add-custom-acai] Criando novo carrinho para usuário ${userId}.`);
            cart = await prisma.carrinho.create({
                data: { lojaId: req.lojaId, usuarioId: userId },
            });
        } else if (cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Criar estrutura de opções personalizadas
        const opcoesSelecionadas = {
            customAcai: {
                value: value,
                selectedComplements: selectedComplements || [],
                complementNames: complementNames || []
            }
        };

        // Adicionar item do açaí personalizado ao carrinho
        // Cada açaí personalizado é único, então sempre criar novo item
        const cartItem = await prisma.item_carrinho.create({
            data: {
                carrinhoId: cart.id,
                produtoId: customAcaiProduct.id,
                quantidade: quantity,
                opcoesSelecionadas: opcoesSelecionadas
            }
        });

        console.log(`✅ [POST /api/cart/add-custom-acai] Açaí personalizado adicionado com sucesso. Item ID: ${cartItem.id}`);
        res.status(201).json({ 
            message: 'Açaí personalizado adicionado ao carrinho com sucesso.', 
            cartItem: cartItem 
        });

    } catch (err) {
        console.error(`❌ [POST /api/cart/add-custom-acai] Erro ao adicionar açaí personalizado para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao adicionar açaí personalizado ao carrinho.', error: err.message });
    }
});

module.exports = router;
