const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcrypt');
const { authenticateToken, authorize } = require('./auth');
const { sendDeliveryNotifications, sendPickupNotification, sendPaymentConfirmationNotification, sendCookNotification, sendDeliveredConfirmationNotification, sendOrderCancellationNotification, sendOrderEditNotification, getWhatsappTemplates, interpolateTemplate, checkPhoneExistsWhatsApp } = require('../services/messageService');
const { triggerAutoPrint } = require('../services/autoPrintService');
const { publishEvent } = require('../services/realtimeEvents');
const axios = require('axios');
const { normalizeNeighborhoodName } = require('./deliveryNeighborhoods');

// Permite que admin/master e garçons criem pedidos de mesa/balcão
const authorizeAdminOrWaiter = (req, res, next) => {
    const allowedRoles = ['admin', 'master', 'waiter'];
    const role = req.user?.funcao;

    if (!role || !allowedRoles.includes(role)) {
        return res.status(403).json({ message: 'Acesso negado: você não tem permissão para realizar esta ação.' });
    }

    next();
};

// Função auxiliar para parsear opcoesSelecionadasSnapshot corretamente
// Garante que o JSON seja sempre parseado, mesmo quando vem como string do MySQL/Prisma
function parseOptionsSnapshot(snapshot) {
    if (!snapshot) {
        return null;
    }
    
    // Se já é um objeto, retornar diretamente
    if (typeof snapshot === 'object' && snapshot !== null) {
        return snapshot;
    }
    
    // Se é uma string, tentar fazer parse
    if (typeof snapshot === 'string') {
        try {
            return JSON.parse(snapshot);
        } catch (err) {
            console.warn('⚠️ Erro ao fazer parse do opcoesSelecionadasSnapshot:', err.message, 'Snapshot:', snapshot);
            return null;
        }
    }
    
    return null;
}

/** Primeira vez em "being_prepared": grava o instante para o cronômetro do painel (não conta espera em pagamento pendente). */
function patchInicioPreparoSeNecessario(existingOrder, newStatus) {
    if (newStatus !== 'being_prepared') return {};
    if (existingOrder.inicioPreparoEm) return {};
    return { inicioPreparoEm: new Date() };
}

function getBrazilDayKey(date) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(date);
    } catch {
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

function buildDailyNumberMap(orders) {
    const sorted = [...(orders || [])].sort((a, b) => {
        const aTime = new Date(a.criadoEm).getTime();
        const bTime = new Date(b.criadoEm).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return (a.id || 0) - (b.id || 0);
    });

    const counters = new Map();
    const map = new Map();

    for (const order of sorted) {
        const key = getBrazilDayKey(new Date(order.criadoEm));
        const current = (counters.get(key) || 0) + 1;
        counters.set(key, current);
        map.set(order.id, current);
    }

    return map;
}

async function getDailyNumber(orderId, lojaId, criadoEm) {
    try {
        const dayKey = getBrazilDayKey(new Date(criadoEm));
        const dayStart = new Date(dayKey + 'T00:00:00-03:00');
        const dayEnd = new Date(dayKey + 'T23:59:59-03:00');
        const count = await prisma.pedido.count({
            where: {
                lojaId,
                criadoEm: { gte: dayStart, lte: dayEnd },
                id: { lte: orderId }
            }
        });
        return count;
    } catch {
        return null;
    }
}

// Função auxiliar para obter credenciais Z-API da loja (DB) com fallback para env vars
async function getZApiCredentials(lojaId) {
  try {
    if (lojaId) {
      const config = await prisma.configuracao_loja.findUnique({ where: { lojaId } });
      if (config?.zapApiToken && config?.zapApiInstance && config?.zapApiClientToken) {
        return {
          zapApiToken: config.zapApiToken,
          zapApiInstance: config.zapApiInstance,
          zapApiClientToken: config.zapApiClientToken,
        };
      }
    }
  } catch (err) {
    console.warn('⚠️ [Z-API] Erro ao buscar credenciais da loja, usando env vars:', err.message);
  }
  return {
    zapApiToken: process.env.zapApiToken,
    zapApiInstance: process.env.zapApiInstance,
    zapApiClientToken: process.env.zapApiClientToken,
  };
}

// Função auxiliar para obter o ID do usuário "Balcão" da loja.
// Se o usuário não existir, cria automaticamente.
async function getUsuarioBalcaoId(lojaId) {
    // Buscar usuário existente
    let usuarioBalcao = await prisma.usuario.findFirst({
        where: {
            lojaId,
            nomeUsuario: 'USUARIO_BALCAO'
        }
    });

    // Se não existir, criar automaticamente
    if (!usuarioBalcao) {
        console.log(`👤 [getUsuarioBalcaoId] Usuário de balcão não encontrado para loja ${lojaId}. Criando automaticamente...`);
        
        // Gerar uma senha aleatória (não será usada para login, mas é obrigatória no schema)
        const senhaAleatoria = `balcao_${lojaId}_${Date.now()}`;
        const hashedPassword = await bcrypt.hash(senhaAleatoria, 10);
        
        try {
            usuarioBalcao = await prisma.usuario.create({
                data: {
                    lojaId,
                    nomeUsuario: 'USUARIO_BALCAO',
                    senha: hashedPassword,
                    funcao: 'user',
                    // Email e telefone podem ser null, mas precisamos evitar conflitos de unique constraint
                    // Usar valores únicos por loja para evitar erros
                    email: `balcao_${lojaId}@sistema.local`,
                    telefone: `9999999999${String(lojaId).padStart(3, '0')}` // Telefone único por loja
                }
            });
            console.log(`✅ [getUsuarioBalcaoId] Usuário de balcão criado com sucesso (ID: ${usuarioBalcao.id}) para loja ${lojaId}`);
        } catch (err) {
            console.error(`❌ [getUsuarioBalcaoId] Erro ao criar usuário de balcão:`, err.message);
            throw new Error(`Erro ao criar usuário de balcão: ${err.message}`);
        }
    }

    return usuarioBalcao.id;
}

// Função para enviar mensagem via WhatsApp (endpoint send-text)
async function sendWhatsAppMessageZApi(phone, message, lojaId) {
  const cleanPhone = phone.replace(/\D/g, '');
  const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
  const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-text`;

  await axios.post(
    zapApiUrl,
    {
      phone: `55${cleanPhone}`,
      message
    },
    {
      headers: {
        'Client-Token': zapApiClientToken,
      }
    }
  );
}

// Função para enviar mensagem com botão de copiar código (OTP Button) usando a Z-API
async function sendWhatsAppButtonOtpZApi(phone, message, code, lojaId, buttonText) {
  const cleanPhone = phone.replace(/\D/g, '');
  const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
  const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-button-otp`;

  const body = {
    phone: `55${cleanPhone}`,
    message,
    code: String(code ?? '')
  };

  if (buttonText) {
    body.buttonText = buttonText;
  }

  console.log('📱 [Z-API] Enviando send-button-otp para:', `55${cleanPhone}`);
  console.log('📱 [Z-API] Body:', JSON.stringify(body, null, 2));

  const response = await axios.post(
    zapApiUrl,
    body,
    {
      headers: {
        'client-token': zapApiClientToken,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('✅ [Z-API] send-button-otp resposta:', response.status, JSON.stringify(response.data));
  return response;
}

// Função auxiliar para formatar item do carrinho com sabores e complementos
async function formatCartItemForMessage(item, allFlavors = []) {
    try {
        const productName = item.produto?.nome || 'Produto';
        const quantity = item.quantidade || 1;
        
        // Buscar complementos
        const complementosList = [];
        if (item.complementos && item.complementos.length > 0) {
            item.complementos.forEach(ic => {
                const complementName = ic.complemento?.nome;
                if (complementName) {
                    complementosList.push(complementName);
                }
            });
        }

        // Buscar adicionais
        const adicionaisList = [];
        if (item.adicionais && item.adicionais.length > 0) {
            item.adicionais.forEach(ia => {
                const additionalName = ia.adicional?.nome;
                const additionalQty = Number(ia.quantidade || 1);
                if (additionalName) {
                    adicionaisList.push(`${additionalQty}x ${additionalName}`);
                }
            });
        }
        
        // Buscar sabores
        const saboresList = [];
        if (item.sabores && item.sabores.length > 0) {
            item.sabores.forEach(s => {
                const saborName = s.sabor?.nome;
                if (saborName) {
                    saboresList.push(saborName);
                }
            });
        }

        // Buscar sabores do opcoesSelecionadas (retrocompatibilidade)
        const optionsSnapshot = item.opcoesSelecionadas || item.opcoesSelecionadasSnapshot;
        const parsedSnapshot = parseOptionsSnapshot(optionsSnapshot);
        
        if (parsedSnapshot && allFlavors.length > 0) {
            let selectedFlavors = {};
            
            if (parsedSnapshot.selectedFlavors) {
                selectedFlavors = parsedSnapshot.selectedFlavors;
            } else if (parsedSnapshot.flavors) {
                selectedFlavors = parsedSnapshot.flavors;
            }
            
            if (Object.keys(selectedFlavors).length > 0) {
                const flavorIds = [];
                Object.values(selectedFlavors).forEach((ids) => {
                    if (Array.isArray(ids)) {
                        flavorIds.push(...ids.map(id => Number(id)));
                    }
                });
                
                // Mapear IDs para nomes dos sabores
                const flavors = allFlavors.filter(flavor => 
                    flavorIds.includes(flavor.id) || flavorIds.includes(Number(flavor.id))
                );
                
                flavors.forEach(flavor => {
                    const flavorName = flavor.nome || flavor.name;
                    if (flavorName) {
                        saboresList.push(flavorName);
                    }
                });
            }
        }
        
        // Remover sabores duplicados (podem vir tanto da relação quanto do snapshot)
        const uniqueSaboresList = [...new Set(saboresList)];
        
        // Formatar string do item
        let itemText = `• ${quantity}x ${productName}`;
        
        if (uniqueSaboresList.length > 0) {
            itemText += `\n  Sabores: ${uniqueSaboresList.join(', ')}`;
        }
        
        if (complementosList.length > 0) {
            itemText += `\n  Complementos: ${complementosList.join(', ')}`;
        }

        if (adicionaisList.length > 0) {
            itemText += `\n  Adicionais: ${adicionaisList.join(', ')}`;
        }

        // Buscar observação do item
        const parsedObs = parseOptionsSnapshot(item.opcoesSelecionadas);
        const obsText = parsedObs?.observacao || '';
        if (obsText.trim()) {
            itemText += `\n  Obs: ${obsText.trim()}`;
        }
        
        return itemText;
    } catch (error) {
        console.error('❌ Erro ao formatar item do carrinho:', error);
        const productName = item.produto?.nome || 'Produto';
        const quantity = item.quantidade || 1;
        return `• ${quantity}x ${productName}`;
    }
}

/** Valida PIX / cartão / dinheiro conforme tipo (delivery vs retirada) e flags da loja. */
function isCheckoutPaymentAllowed(paymentMethod, tipoEntrega, cfg) {
    const pix = cfg?.pagamentoPixAtivo !== false;
    const cashDel = cfg?.pagamentoDinheiroEntregaAtivo !== false;
    const cashPick = cfg?.pagamentoDinheiroRetiradaAtivo !== false;
    const cardDel = cfg?.pagamentoCartaoEntregaAtivo !== false;
    const cardPick = cfg?.pagamentoCartaoRetiradaAtivo !== false;
    if (paymentMethod === 'PIX') return pix;
    if (paymentMethod === 'CREDIT_CARD') return tipoEntrega === 'delivery' ? cardDel : cardPick;
    if (paymentMethod === 'CASH_ON_DELIVERY') return tipoEntrega === 'delivery' ? cashDel : cashPick;
    return false;
}

// Rota para criar um pedido a partir do carrinho
router.post('/', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { paymentMethod, tipoEntrega, deliveryType, taxaEntrega, deliveryFee, notes, addressId, precisaTroco, valorTroco } = req.body;
    
    // Aceitar tanto deliveryType (do frontend) quanto tipoEntrega
    const tipo = deliveryType || tipoEntrega || 'delivery';
    
    // Taxa de entrega será calculada no servidor (por bairro). Nunca confiar no valor vindo do cliente.
    let taxa = 0;
    
    if (!paymentMethod) {
        return res.status(400).json({ message: 'Forma de pagamento não informada.' });
    }
    console.log(`[POST /api/orders] Recebida requisição para criar um pedido. Usuário ID: ${userId}, Tipo: ${tipo}, Taxa: R$ ${taxa}${notes ? ', Observações: Sim' : ''}${addressId ? `, Endereço ID: ${addressId}` : ''}`);

    try {
        const storeConfigOrder = await prisma.configuracao_loja.findUnique({
            where: { lojaId: req.lojaId }
        });

        const allowedMethodCodes = ['PIX', 'CREDIT_CARD', 'CASH_ON_DELIVERY'];
        if (!allowedMethodCodes.includes(paymentMethod)) {
            return res.status(400).json({ message: 'Forma de pagamento inválida.' });
        }
        if (!isCheckoutPaymentAllowed(paymentMethod, tipo, storeConfigOrder)) {
            return res.status(400).json({
                message: 'Esta forma de pagamento não está disponível para este tipo de pedido.'
            });
        }

        if (tipo === 'delivery') {
            const deliveryEnabled = (storeConfigOrder?.deliveryAtivo ?? true);
            if (!deliveryEnabled) {
                return res.status(400).json({
                    message: 'Entrega em casa está desativada no momento. Selecione retirada no local.',
                    deliveryDisabled: true
                });
            }
        }

        // Encontrar o carrinho e o usuário com seus endereços em uma única busca
        const [cart, user] = await Promise.all([
            prisma.carrinho.findUnique({
                where: { usuarioId: userId },
                include: {
                    itens: {
                        include: {
                            produto: true,
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
            }),
            prisma.usuario.findUnique({
                where: { id: userId },
                include: {
                    enderecos: true
                }
            })
        ]);

        if (!user || user.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        if (cart && cart.lojaId !== req.lojaId) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        if (!cart || cart.itens.length === 0) {
            console.warn(`[POST /api/orders] Carrinho do usuário ${userId} está vazio.`);
            return res.status(400).json({ message: 'Carrinho vazio. Adicione itens antes de criar um pedido.' });
        }

        // Para entrega, verificar se tem endereço
        let shippingAddress = null;
        if (tipo === 'delivery') {
            // Se foi fornecido um addressId, usar esse endereço específico
            if (addressId) {
                shippingAddress = user.enderecos.find(addr => addr.id === parseInt(addressId));
                if (!shippingAddress) {
                    console.warn(`[POST /api/orders] Endereço ID ${addressId} não encontrado para o usuário ${userId}.`);
                    return res.status(400).json({
                        message: 'Endereço selecionado não encontrado. Por favor, selecione um endereço válido.',
                        redirectPath: '/checkout'
                    });
                }
                console.log(`[POST /api/orders] Usando endereço selecionado ID: ${addressId}`);
            } else {
                // Fallback: usar endereço padrão ou o primeiro disponível
            shippingAddress = user.enderecos.find(addr => addr.padrao) || user.enderecos[0];
                console.log(`[POST /api/orders] Usando endereço padrão ou primeiro disponível`);
            }
            
            if (!shippingAddress) {
                console.warn(`[POST /api/orders] Usuário ${userId} não possui endereço de entrega cadastrado.`);
                return res.status(400).json({
                    message: 'Nenhum endereço de entrega encontrado. Por favor, cadastre um para continuar.',
                    redirectPath: '/api/auth/profile/enderecos'
                });
            }
        }
        
        // Calcular taxa por bairro (apenas para delivery)
        if (tipo === 'delivery') {
            const storeConfig = await prisma.configuracao_loja.findUnique({
                where: { lojaId: req.lojaId }
            });

            const taxaPadrao = Number(storeConfig?.taxaEntrega ?? 0);
            const bairroNome = shippingAddress?.bairro ? String(shippingAddress.bairro).trim() : '';
            const nomeNormalizado = bairroNome ? normalizeNeighborhoodName(bairroNome) : '';

            if (nomeNormalizado) {
                const bairro = await prisma.bairro_entrega.findFirst({
                    where: { lojaId: req.lojaId, nomeNormalizado }
                });
                taxa = bairro ? Number(bairro.taxaEntrega) : taxaPadrao;
            } else {
                taxa = taxaPadrao;
            }
        }

        // Calcular o preço total do pedido (SEM taxa de entrega ainda)
        const subprecoTotal = cart.itens.reduce((acc, item) => {
            // Verificar se é produto personalizado
            let itemPrice = item.produto.preco;
            if (item.opcoesSelecionadas) {
                if (item.opcoesSelecionadas.customAcai) {
                    itemPrice = item.opcoesSelecionadas.customAcai.value;
                } else if (item.opcoesSelecionadas.customSorvete) {
                    itemPrice = item.opcoesSelecionadas.customSorvete.value;
                } else if (item.opcoesSelecionadas.customProduct) {
                    itemPrice = item.opcoesSelecionadas.customProduct.value;
                }
            }

            const adicionaisTotal = (item.adicionais && item.adicionais.length > 0)
                ? item.adicionais.reduce((sum, a) => {
                    const value = Number(a.adicional?.valor || 0);
                    const qty = Number(a.quantidade || 1);
                    return sum + (value * qty);
                }, 0)
                : 0;

            const unitTotal = Number(itemPrice || 0) + Number(adicionaisTotal || 0);
            return acc + (Number(item.quantidade || 0) * unitTotal);
        }, 0);

        // Valor mínimo do pedido (configurado na loja)
        const storeConfigMin = await prisma.configuracao_loja.findUnique({
            where: { lojaId: req.lojaId }
        });
        const valorMinimo = storeConfigMin?.valorPedidoMinimo != null ? Number(storeConfigMin.valorPedidoMinimo) : null;
        if (valorMinimo != null && valorMinimo > 0 && subprecoTotal < valorMinimo) {
            return res.status(400).json({
                message: `O pedido mínimo é R$ ${valorMinimo.toFixed(2).replace('.', ',')}. Seu carrinho está em R$ ${subprecoTotal.toFixed(2).replace('.', ',')}. Adicione mais itens para continuar.`,
                minOrderValue: valorMinimo,
                currentTotal: subprecoTotal
            });
        }
        
        // Verificar se há promoção de frete grátis ativa
        let freteGratis = false;
        if (tipo === 'delivery' && taxa > 0) {
            const storeConfig = await prisma.configuracao_loja.findUnique({
                where: { lojaId: req.lojaId }
            });
            if (storeConfig && storeConfig.promocaoTaxaAtiva) {
                // Função auxiliar para obter o dia da semana no fuso horário do Brasil
                const getDayOfWeekInBrazil = () => {
                    const brasilNow = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
                    const dateInBrazil = new Date(brasilNow);
                    return dateInBrazil.getDay(); // 0 = domingo, 1 = segunda, ..., 6 = sábado
                };
                
                const hoje = getDayOfWeekInBrazil().toString(); // 0 = domingo, 1 = segunda, etc. (horário do Brasil)
                const diasPromo = storeConfig.promocaoDias ? storeConfig.promocaoDias.split(',') : [];
                
                // Verificar se hoje é um dia de promoção
                if (diasPromo.includes(hoje)) {
                    const valorMinimo = parseFloat(storeConfig.promocaoValorMinimo || 0);
                    // Verificar se o subtotal atinge o valor mínimo
                    if (subprecoTotal >= valorMinimo) {
                        taxa = 0; // Frete grátis!
                        freteGratis = true;
                        console.log(`🎉 [POST /api/orders] PROMOÇÃO APLICADA! Frete grátis para pedido acima de R$ ${valorMinimo.toFixed(2)}. Subtotal: R$ ${subprecoTotal.toFixed(2)}`);
                    }
                }
            }
        }
        
        const precoTotal = subprecoTotal + (tipo === 'delivery' ? taxa : 0);

        console.log(`[POST /api/orders] Criando pedido para o usuário ${userId} com preço total de ${precoTotal.toFixed(2)} (${tipo}, Taxa: R$ ${taxa}${freteGratis ? ' - FRETE GRÁTIS' : ''}).`);

        // Determinar status inicial antes da transação
        const initialStatus = (paymentMethod === 'CREDIT_CARD' || paymentMethod === 'CASH_ON_DELIVERY') ? 'being_prepared' : 'pending_payment';

        const storeConfig = await prisma.configuracao_loja.findUnique({
            where: { lojaId: req.lojaId }
        });
        const storeName = storeConfig?.nomeLoja || req.loja?.nome || 'Delivery';
        const ruaLoja = storeConfig?.ruaLoja || '';
        const numeroLoja = storeConfig?.numeroLoja || '';
        const bairroLoja = storeConfig?.bairroLoja || '';
        const pontoRefLoja = storeConfig?.pontoReferenciaLoja || '';
        const estimativaEntrega = storeConfig?.estimativaEntrega || '';
        const storeAddressText = [
            ruaLoja,
            numeroLoja ? `Nº ${numeroLoja}` : '',
            bairroLoja
        ].filter(Boolean).join(', ') || null;
        const storePixKey = storeConfig?.chavePix || storeConfig?.telefoneWhatsapp || null;

        const userData = user;
        const allFlavors = await prisma.sabor.findMany({
            where: { lojaId: req.lojaId }
        });

        const newOrder = await prisma.$transaction(async (tx) => {
            const createdOrder = await tx.pedido.create({
                data: {
                    lojaId: req.lojaId,
                    usuarioId: userId,
                    status: initialStatus,
                    inicioPreparoEm: initialStatus === 'being_prepared' ? new Date() : null,
                    precoTotal: precoTotal,
                    complementoEntrega: shippingAddress?.complemento || null,
                    bairroEntrega: shippingAddress?.bairro || null,
                    numeroEntrega: shippingAddress?.numero || null,
                    ruaEntrega: shippingAddress?.rua || null,
                    referenciaEntrega:
                        tipo === 'delivery' && shippingAddress?.pontoReferencia
                            ? String(shippingAddress.pontoReferencia).trim() || null
                            : null,
                    telefoneEntrega: userData?.telefone || null,
                    taxaEntrega: tipo === 'delivery' ? taxa : 0,
                    tipoEntrega: tipo,
                    metodoPagamento: paymentMethod,
                    observacoes: notes || null,
                    precisaTroco: precisaTroco || false,
                    valorTroco: valorTroco ? parseFloat(valorTroco) : null,
                    pagamento: {
                        create: {
                            valor: precoTotal,
                            metodo: paymentMethod,
                            status: paymentMethod === 'PIX' ? 'PENDING' : 'PAID',
                            idTransacao: null
                        }
                    },
                    itens_pedido: {
                        create: cart.itens.map((item) => {
                            let itemPrice = item.produto.preco;
                            if (item.opcoesSelecionadas) {
                                if (item.opcoesSelecionadas.customAcai) itemPrice = item.opcoesSelecionadas.customAcai.value;
                                else if (item.opcoesSelecionadas.customSorvete) itemPrice = item.opcoesSelecionadas.customSorvete.value;
                                else if (item.opcoesSelecionadas.customProduct) itemPrice = item.opcoesSelecionadas.customProduct.value;
                            }

                            return {
                                produtoId: item.produtoId,
                                quantidade: item.quantidade,
                                precoNoPedido: itemPrice,
                                opcoesSelecionadasSnapshot: item.opcoesSelecionadas || undefined,
                                complementos: item.complementos && item.complementos.length > 0
                                    ? {
                                        create: item.complementos.map((c) => ({ complementoId: c.complementoId }))
                                    }
                                    : undefined,
                                adicionais: item.adicionais && item.adicionais.length > 0
                                    ? {
                                        create: item.adicionais.map((a) => ({ adicionalId: a.adicionalId, quantidade: a.quantidade || 1 }))
                                    }
                                    : undefined,
                                sabores: item.sabores && item.sabores.length > 0
                                    ? {
                                        create: item.sabores.map((s) => ({ saborId: s.saborId, quantidade: s.quantidade || 1 }))
                                    }
                                    : undefined
                            };
                        })
                    }
                },
                include: {
                    itens_pedido: true,
                    pagamento: true
                }
            });

            await tx.item_carrinho_adicional.deleteMany({
                where: { itemCarrinho: { carrinhoId: cart.id } }
            });
            await tx.item_carrinho_complemento.deleteMany({
                where: { itemCarrinho: { carrinhoId: cart.id } }
            });
            await tx.item_carrinho_sabor.deleteMany({
                where: { itemCarrinho: { carrinhoId: cart.id } }
            });
            await tx.item_carrinho.deleteMany({
                where: { carrinhoId: cart.id }
            });

            return createdOrder;
        });

        // Calcular dailyNumber para o pedido recém-criado
        const todayKey = getBrazilDayKey(new Date(newOrder.criadoEm));
        const todayStart = new Date(todayKey + 'T00:00:00-03:00');
        const todayEnd = new Date(todayKey + 'T23:59:59-03:00');
        const ordersToday = await prisma.pedido.count({
            where: {
                lojaId: req.lojaId,
                criadoEm: { gte: todayStart, lte: todayEnd },
                id: { lte: newOrder.id }
            }
        });
        const dailyNumber = ordersToday;

        const newOrderWithParsedOptions = {
            ...newOrder,
            dailyNumber,
            itens_pedido: (newOrder.itens_pedido || []).map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };

        await publishEvent(req.lojaId, 'NEW_ORDER', newOrderWithParsedOptions);

        if (initialStatus === 'being_prepared') {
            await publishEvent(req.lojaId, 'ORDER_BEING_PREPARED', newOrderWithParsedOptions);
        }

        // Formatar itens com sabores e complementos
        const itens = await Promise.all(
            cart.itens.map(item => formatCartItemForMessage(item, allFlavors))
        );
        const itensText = itens.join('\n');

        const estimativaEntregaText = estimativaEntrega && String(estimativaEntrega).trim()
            ? `\n⏱️ *Estimativa:* ${String(estimativaEntrega).trim()}`
            : '';

        // Informações de entrega/retirada
        const deliveryInfo = tipo === 'pickup' 
            ? `📍 *Retirada no local*\n🏪 *Local:* ${storeName}${estimativaEntregaText}`
            : `*Entrega em casa*${estimativaEntregaText}\n📍 Endereço: ${shippingAddress.rua}, ${shippingAddress.numero}${shippingAddress.complemento ? ` - ${shippingAddress.complemento}` : ''}\nBairro: ${shippingAddress.bairro}${shippingAddress.pontoReferencia ? `\n*Referência:* ${shippingAddress.pontoReferencia}` : ''}`;
            
            // Adicionar observações se houver
            const notesSection = notes && notes.trim() ? `\n\n📝 *Observações:*\n${notes.trim()}` : '';

            const waTemplates = await getWhatsappTemplates(req.lojaId);
            const totalPriceStr = Number(newOrder.precoTotal).toFixed(2);
            const dailyNumberStr = String(dailyNumber);

            let message;

            if (paymentMethod === 'CREDIT_CARD') {
                const prepFooterLine =
                    tipo === 'pickup'
                        ? ' Você pode retirar em breve!'
                        : ' Em breve será enviado para entrega.';
                message = interpolateTemplate(waTemplates.orderCreatedCard, {
                    dailyNumber: dailyNumberStr,
                    itemsList: itensText,
                    totalPrice: totalPriceStr,
                    deliveryInfo,
                    notesSection,
                    prepFooterLine,
                });
            } else if (paymentMethod === 'CASH_ON_DELIVERY') {
                const trocoLine =
                    precisaTroco && valorTroco
                        ? `\n💰 *Troco para:* R$ ${parseFloat(valorTroco).toFixed(2)}`
                        : '';
                const cashPaymentLabel = `Dinheiro ${tipo === 'pickup' ? 'na Retirada' : 'na Entrega'}`;
                const cashChangeFooterLine =
                    tipo === 'pickup'
                        ? 'Tenha o dinheiro trocado em mãos na retirada.'
                        : 'Tenha o dinheiro trocado em mãos na entrega.';
                message = interpolateTemplate(waTemplates.orderCreatedCash, {
                    dailyNumber: dailyNumberStr,
                    itemsList: itensText,
                    totalPrice: totalPriceStr,
                    trocoLine,
                    cashPaymentLabel,
                    deliveryInfo,
                    notesSection,
                    cashChangeFooterLine,
                });
            } else {
                const pixKeyIntroLine = storePixKey ? (waTemplates.orderCreatedPixKeyIntro ?? '') : '';
                message = interpolateTemplate(waTemplates.orderCreatedPix, {
                    dailyNumber: dailyNumberStr,
                    itemsList: itensText,
                    totalPrice: totalPriceStr,
                    pixKeyIntroLine,
                    deliveryInfo,
                    notesSection,
                });
            }

            try {
                if (paymentMethod === 'PIX' && storePixKey) {
                    try {
                        await sendWhatsAppButtonOtpZApi(
                            userData.telefone,
                            message,
                            storePixKey,
                            req.lojaId,
                            'Copiar chave Pix'
                        );
                        console.log('✅ Mensagem PIX (button-otp) enviada para:', userData.telefone);
                    } catch (otpErr) {
                        console.error('⚠️ Falha no send-button-otp, usando send-text como fallback:', otpErr.response?.data || otpErr.message);
                        const fallbackMessage =
                            message +
                            (storePixKey
                                ? interpolateTemplate(waTemplates.orderCreatedPixFallbackAppend, { storePixKey })
                                : '');
                        await sendWhatsAppMessageZApi(userData.telefone, fallbackMessage, req.lojaId);
                        console.log('✅ Mensagem PIX (fallback send-text) enviada para:', userData.telefone);
                    }
                } else {
                    await sendWhatsAppMessageZApi(userData.telefone, message, req.lojaId);
                    console.log('✅ Mensagem enviada para:', userData.telefone);
                }
            } catch (err) {
                console.error('❌ Erro ao enviar mensagem via Z-API:', err.response?.data || err.message);
            }

        // Se o pedido já está em preparo (cartão ou dinheiro), notificar cozinheiros
        if (initialStatus === 'being_prepared') {
            try {
                // Buscar pedido completo com relacionamentos
                const pedidoCompleto = await prisma.pedido.findFirst({
                    where: { id: newOrder.id, lojaId: req.lojaId },
                    include: {
                        usuario: true,
                        itens_pedido: {
                            include: {
                                produto: true,
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

                if (!pedidoCompleto) {
                    console.error('❌ Pedido completo não encontrado após criação; notificação/impressão ignorada.');
                } else {
                console.log('👨‍🍳 Notificando todos os cozinheiros ativos');
                pedidoCompleto.dailyNumber = dailyNumber;

                // Cupom / AUTO_PRINT: o carrinho ainda tem `produto` em memória após a transação;
                // mescla com o pedido para não perder nome do item no JSON da impressão.
                const pickTrim = (...vals) => {
                    for (const v of vals) {
                        if (v === null || v === undefined) continue;
                        const t = String(v).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                        if (t) return t;
                    }
                    return '';
                };
                const cartProductById = new Map(
                    (cart?.itens || []).map((ci) => [ci.produtoId, ci.produto])
                );
                pedidoCompleto.usuario = {
                    id: pedidoCompleto.usuario?.id ?? userData?.id,
                    nomeUsuario:
                        pickTrim(pedidoCompleto.usuario?.nomeUsuario, userData?.nomeUsuario) || 'Cliente',
                    email: pickTrim(pedidoCompleto.usuario?.email, userData?.email) || null,
                    telefone: pickTrim(
                        pedidoCompleto.usuario?.telefone,
                        userData?.telefone,
                        pedidoCompleto.telefoneEntrega
                    ) || null,
                    funcao: pedidoCompleto.usuario?.funcao ?? userData?.funcao,
                };
                pedidoCompleto.itens_pedido = (pedidoCompleto.itens_pedido || []).map((ip) => {
                    const fromCart = cartProductById.get(ip.produtoId);
                    const mergedProduto =
                        ip.produto && pickTrim(ip.produto.nome)
                            ? ip.produto
                            : fromCart || ip.produto || null;
                    return { ...ip, produto: mergedProduto };
                });

                await sendCookNotification(pedidoCompleto);
                triggerAutoPrint(pedidoCompleto, 'order_created_as_being_prepared');
                }
            } catch (err) {
                console.error('❌ Erro ao notificar cozinheiros:', err);
            }
        }

        res.status(201).json({ message: 'Pedido criado com sucesso!', order: newOrderWithParsedOptions });
    } catch (err) {
        console.error(`[POST /api/orders] Erro ao criar o pedido para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao criar o pedido.', error: err.message });
    }
});

// Rota para criar pedido de balcão/mesa (PDV) - admin/master/waiter
router.post('/balcao', authenticateToken, authorizeAdminOrWaiter, async (req, res) => {
    const lojaId = req.lojaId;

    try {
        const { itens, pagamento, dadosCliente, observacaoPedido, enderecoEntrega, deliveryType } = req.body || {};

        if (!Array.isArray(itens) || itens.length === 0) {
            return res.status(400).json({ message: 'Itens do pedido são obrigatórios.' });
        }

        if (!pagamento || !pagamento.metodoPagamento) {
            return res.status(400).json({ message: 'Dados de pagamento são obrigatórios.' });
        }

        const usuarioBalcaoId = await getUsuarioBalcaoId(lojaId);

        // Buscar produtos e montar subtotal
        const produtoIds = [...new Set(itens.map(i => i.produtoId))];
        const produtos = await prisma.produto.findMany({
            where: {
                id: { in: produtoIds },
                lojaId
            }
        });

        const produtosMap = new Map(produtos.map(p => [p.id, p]));

        let subtotal = 0;

        // Buscar todos os adicionais para calcular preços
        const adicionalIds = new Set();
        itens.forEach(item => {
            if (item.adicionals && Array.isArray(item.adicionals)) {
                console.log('🔍 [PDV] Item com adicionais:', JSON.stringify(item.adicionals));
                item.adicionals.forEach(a => {
                    if (a.id) adicionalIds.add(a.id);
                });
            }
        });
        
        console.log('🔍 [PDV] IDs de adicionais encontrados:', Array.from(adicionalIds));
        
        const adicionaisMap = new Map();
        if (adicionalIds.size > 0) {
            const adicionais = await prisma.adicional.findMany({
                where: {
                    id: { in: Array.from(adicionalIds) },
                    lojaId: lojaId
                }
            });
            console.log('🔍 [PDV] Adicionais encontrados no banco:', adicionais.length);
            adicionais.forEach(a => adicionaisMap.set(a.id, a));
        }

        // Pré-calcular itens com preço
        const itensCalculados = itens.map((item) => {
            const produto = produtosMap.get(item.produtoId);
            if (!produto) {
                throw new Error(`Produto ID ${item.produtoId} não encontrado para esta loja.`);
            }

            let itemPrice = Number(produto.preco || 0);

            // Adicionar preço dos adicionais
            if (item.adicionals && Array.isArray(item.adicionals) && item.adicionals.length > 0) {
                const adicionaisTotal = item.adicionals.reduce((sum, a) => {
                    const adicional = adicionaisMap.get(a.id);
                    if (adicional) {
                        const qty = Number(a.quantity || 1);
                        const valorAdicional = (Number(adicional.valor) || 0) * qty;
                        console.log(`💰 [PDV] Adicional ${adicional.nome}: ${qty}x R$ ${adicional.valor} = R$ ${valorAdicional}`);
                        return sum + valorAdicional;
                    } else {
                        console.warn(`⚠️ [PDV] Adicional ID ${a.id} não encontrado no banco`);
                    }
                    return sum;
                }, 0);
                if (adicionaisTotal > 0) {
                    console.log(`💰 [PDV] Total de adicionais para item ${produto.nome}: R$ ${adicionaisTotal}`);
                    itemPrice += adicionaisTotal;
                }
            }

            // Caso você use opções customizadas no PDV, pode ler de item.opcoesSelecionadas aqui
            // Exemplo: if (item.opcoesSelecionadas?.customProduct) itemPrice = item.opcoesSelecionadas.customProduct.value;

            const quantidade = Number(item.quantidade || 1);
            const totalItem = quantidade * itemPrice;
            subtotal += totalItem;

            return {
                origem: item,
                produto,
                quantidade,
                itemPrice
            };
        });

        // Aceitar 'dine_in' (consumo no local), 'delivery' (entrega) ou 'pickup' (retirada)
        const tipoRecebido = (deliveryType || req.body?.tipoEntrega || 'pickup').toLowerCase();
        const tipoEntrega = tipoRecebido === 'delivery' ? 'delivery' 
                          : tipoRecebido === 'dine_in' ? 'dine_in'
                          : 'pickup';
        
        // Calcular taxa de entrega se for delivery e tiver endereço
        let taxaEntrega = 0;
        if (tipoEntrega === 'delivery' && enderecoEntrega?.bairro) {
            try {
                const bairro = await prisma.bairro_entrega.findFirst({
                    where: {
                        lojaId: lojaId,
                        nome: enderecoEntrega.bairro
                    }
                });
                if (bairro) {
                    taxaEntrega = Number(bairro.taxaEntrega) || 0;
                }
            } catch (err) {
                console.warn('⚠️ Erro ao buscar taxa de entrega do bairro:', err.message);
            }
        }
        
        const precoTotal = subtotal + taxaEntrega;
        const telefoneClienteInformado = String(dadosCliente?.telefoneCliente || '').trim() || null;

        // Determinar status inicial: para PDV, normalmente já entra sendo preparado
        const initialStatus = (pagamento.metodoPagamento === 'PIX')
            ? 'pending_payment'
            : 'being_prepared';

        const criadoPorGarcomId = req.user?.funcao === 'waiter' ? req.user.id : null;

        let mesaIdResolved = null;
        const rawMesaId = dadosCliente?.mesaId ?? req.body?.mesaId;
        if (tipoEntrega === 'dine_in' && rawMesaId != null && rawMesaId !== '') {
            const mid = parseInt(String(rawMesaId), 10);
            if (!Number.isNaN(mid)) {
                const mesaRow = await prisma.mesa.findFirst({
                    where: { id: mid, lojaId }
                });
                if (!mesaRow) {
                    return res.status(400).json({ message: 'Mesa não encontrada para esta loja.' });
                }
                mesaIdResolved = mid;
            }
        }

        const newOrder = await prisma.$transaction(async (tx) => {
            const createdOrder = await tx.pedido.create({
                data: {
                    lojaId,
                    usuarioId: usuarioBalcaoId,
                    criadoPorUsuarioId: criadoPorGarcomId,
                    status: initialStatus,
                    inicioPreparoEm: initialStatus === 'being_prepared' ? new Date() : null,
                    precoTotal,
                    taxaEntrega,
                    tipoEntrega,
                    metodoPagamento: pagamento.metodoPagamento,
                    observacoes: observacaoPedido || null,
                    precisaTroco: pagamento.precisaTroco || false,
                    valorTroco: pagamento.valorTroco != null ? parseFloat(pagamento.valorTroco) : null,
                    nomeClienteAvulso: dadosCliente?.nomeClienteAvulso || null,
                    identificadorMesaSenha: dadosCliente?.identificadorMesaSenha || null,
                    mesaId: mesaIdResolved,
                    ruaEntrega: tipoEntrega === 'delivery' && enderecoEntrega?.rua ? enderecoEntrega.rua : null,
                    numeroEntrega: tipoEntrega === 'delivery' && enderecoEntrega?.numero ? enderecoEntrega.numero : null,
                    bairroEntrega: tipoEntrega === 'delivery' && enderecoEntrega?.bairro ? enderecoEntrega.bairro : null,
                    complementoEntrega: tipoEntrega === 'delivery' && enderecoEntrega?.complemento ? enderecoEntrega.complemento : null,
                    referenciaEntrega:
                        tipoEntrega === 'delivery' && enderecoEntrega?.referencia
                            ? String(enderecoEntrega.referencia).trim() || null
                            : null,
                    telefoneEntrega:
                        telefoneClienteInformado ||
                        (tipoEntrega === 'delivery' && enderecoEntrega?.telefone ? String(enderecoEntrega.telefone).trim() : null),
                    pagamento: {
                        create: {
                            valor: precoTotal,
                            metodo: pagamento.metodoPagamento,
                            status: pagamento.metodoPagamento === 'PIX' ? 'PENDING' : 'PAID',
                            idTransacao: null
                        }
                    },
                    itens_pedido: {
                        create: itensCalculados.map(({ origem, produto, quantidade, itemPrice }) => {
                            // Processar sabores do opcoesSelecionadas
                            const selectedFlavors = origem.opcoesSelecionadas?.selectedFlavors || origem.opcoes?.selectedFlavors || {};
                            const saboresArray = [];
                            Object.entries(selectedFlavors).forEach(([categoryId, flavorIds]) => {
                                if (Array.isArray(flavorIds)) {
                                    flavorIds.forEach(flavorId => {
                                        saboresArray.push({ saborId: Number(flavorId), quantidade: 1 });
                                    });
                                }
                            });

                            return {
                                produtoId: produto.id,
                                quantidade,
                                precoNoPedido: itemPrice,
                                opcoesSelecionadasSnapshot: origem.opcoesSelecionadas || origem.opcoes || origem.observacaoItem ? {
                                    ...(origem.opcoesSelecionadas || origem.opcoes || {}),
                                    observacao: origem.observacaoItem || null
                                } : undefined,
                                complementos: origem.complementos && Array.isArray(origem.complementos) && origem.complementos.length > 0
                                    ? {
                                        create: origem.complementos.map((compId) => ({
                                            complementoId: compId
                                        }))
                                    }
                                    : undefined,
                                adicionais: origem.adicionals && Array.isArray(origem.adicionals) && origem.adicionals.length > 0
                                    ? {
                                        create: origem.adicionals.map((a) => {
                                            console.log(`➕ [PDV] Criando adicional: adicionalId=${a.id}, quantidade=${a.quantity || 1}`);
                                            return {
                                                adicionalId: Number(a.id),
                                                quantidade: Number(a.quantity || 1)
                                            };
                                        })
                                    }
                                    : undefined,
                                sabores: saboresArray.length > 0
                                    ? {
                                        create: saboresArray
                                    }
                                    : undefined
                            };
                        })
                    }
                },
                include: {
                    itens_pedido: {
                        include: {
                            produto: true,
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
                    },
                    pagamento: true,
                    usuario: true
                }
            });

            return createdOrder;
        });

        // Calcular dailyNumber para o pedido criado
        const dailyNumber = await getDailyNumber(newOrder.id, newOrder.lojaId, newOrder.criadoEm);
        newOrder.dailyNumber = dailyNumber;

        const newOrderWithParsedOptions = {
            ...newOrder,
            itens_pedido: (newOrder.itens_pedido || []).map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };

        await publishEvent(lojaId, 'NEW_ORDER', newOrderWithParsedOptions);

        if (initialStatus === 'being_prepared') {
            await publishEvent(lojaId, 'ORDER_BEING_PREPARED', newOrderWithParsedOptions);
        }

        // Se houver telefone informado no PDV, enviar confirmação inicial do pedido
        // para esse número (prioridade sobre USUARIO_BALCAO).
        if (telefoneClienteInformado) {
            try {
                const waTemplates = await getWhatsappTemplates(lojaId);
                const storeConfig = await prisma.configuracao_loja.findUnique({
                    where: { lojaId }
                });
                const storePixKey = storeConfig?.chavePix || storeConfig?.telefoneWhatsapp || null;
                const dailyNumberStr = String(dailyNumber || newOrder.id);
                const totalPriceStr = Number(newOrder.precoTotal || 0).toFixed(2);
                const itensText = itensCalculados
                    .map(({ produto, quantidade }) => `• ${quantidade}x ${produto.nome}`)
                    .join('\n');
                const notesSection = observacaoPedido && String(observacaoPedido).trim()
                    ? `\n\n📝 *Observações:*\n${String(observacaoPedido).trim()}`
                    : '';
                const estimativaEntregaText = '';
                const deliveryInfo = tipoEntrega === 'pickup'
                    ? `📍 *Retirada no local*${estimativaEntregaText}`
                    : tipoEntrega === 'delivery'
                        ? `*Entrega em casa*\n📍 Endereço: ${enderecoEntrega?.rua || '-'}, ${enderecoEntrega?.numero || '-'}${enderecoEntrega?.complemento ? ` - ${enderecoEntrega.complemento}` : ''}\nBairro: ${enderecoEntrega?.bairro || '-'}${enderecoEntrega?.referencia ? `\n*Referência:* ${enderecoEntrega.referencia}` : ''}`
                        : `🍽️ *Consumo no local*`;

                let message;
                if (pagamento.metodoPagamento === 'CREDIT_CARD') {
                    const prepFooterLine = tipoEntrega === 'pickup'
                        ? ' Você pode retirar em breve!'
                        : ' Em breve será enviado para entrega.';
                    message = interpolateTemplate(waTemplates.orderCreatedCard, {
                        dailyNumber: dailyNumberStr,
                        itemsList: itensText || 'Itens não disponíveis',
                        totalPrice: totalPriceStr,
                        deliveryInfo,
                        notesSection,
                        prepFooterLine,
                    });
                } else if (pagamento.metodoPagamento === 'CASH_ON_DELIVERY') {
                    const trocoLine =
                        pagamento.precisaTroco && pagamento.valorTroco
                            ? `\n💰 *Troco para:* R$ ${parseFloat(pagamento.valorTroco).toFixed(2)}`
                            : '';
                    const cashPaymentLabel = `Dinheiro ${tipoEntrega === 'pickup' ? 'na Retirada' : 'na Entrega'}`;
                    const cashChangeFooterLine =
                        tipoEntrega === 'pickup'
                            ? 'Tenha o dinheiro trocado em mãos na retirada.'
                            : 'Tenha o dinheiro trocado em mãos na entrega.';
                    message = interpolateTemplate(waTemplates.orderCreatedCash, {
                        dailyNumber: dailyNumberStr,
                        itemsList: itensText || 'Itens não disponíveis',
                        totalPrice: totalPriceStr,
                        trocoLine,
                        cashPaymentLabel,
                        deliveryInfo,
                        notesSection,
                        cashChangeFooterLine,
                    });
                } else {
                    const pixKeyIntroLine = storePixKey ? (waTemplates.orderCreatedPixKeyIntro ?? '') : '';
                    message = interpolateTemplate(waTemplates.orderCreatedPix, {
                        dailyNumber: dailyNumberStr,
                        itemsList: itensText || 'Itens não disponíveis',
                        totalPrice: totalPriceStr,
                        pixKeyIntroLine,
                        deliveryInfo,
                        notesSection,
                    });
                }

                if (pagamento.metodoPagamento === 'PIX' && storePixKey) {
                    try {
                        await sendWhatsAppButtonOtpZApi(
                            telefoneClienteInformado,
                            message,
                            storePixKey,
                            lojaId,
                            'Copiar chave Pix'
                        );
                    } catch (otpErr) {
                        const fallbackMessage =
                            message +
                            interpolateTemplate(waTemplates.orderCreatedPixFallbackAppend, { storePixKey });
                        await sendWhatsAppMessageZApi(telefoneClienteInformado, fallbackMessage, lojaId);
                    }
                } else {
                    await sendWhatsAppMessageZApi(telefoneClienteInformado, message, lojaId);
                }
            } catch (err) {
                console.error('❌ [PDV] Erro ao enviar confirmação inicial para telefone informado:', err.message);
            }
        }

        // Manter notificação para a cozinha (KDS), se o pedido estiver em preparo.
        if (initialStatus === 'being_prepared') {
            try {
                console.log('👨‍🍳 [PDV] Notificando cozinheiros para pedido de balcão');
                await sendCookNotification(newOrderWithParsedOptions);
                triggerAutoPrint(newOrderWithParsedOptions, 'counter_order_created_as_being_prepared');
            } catch (err) {
                console.error('❌ [PDV] Erro ao notificar cozinheiros:', err);
            }
        }

        return res.status(201).json({
            message: 'Pedido de balcão criado com sucesso!',
            order: newOrderWithParsedOptions
        });
    } catch (error) {
        console.error('[POST /api/orders/balcao] Erro ao criar pedido de balcão:', error.message);
        return res.status(500).json({
            message: 'Erro ao criar pedido de balcão.',
            error: error.message
        });
    }
});

// Busca sugestões de cliente por telefone (PDV)
router.get('/balcao/customer-lookup', authenticateToken, authorizeAdminOrWaiter, async (req, res) => {
    try {
        const rawPhone = String(req.query?.phone || '').trim();
        const digits = rawPhone.replace(/\D/g, '');
        if (digits.length < 8) {
            return res.json({ candidates: [] });
        }

        const tail = digits.slice(-8);
        const localUsers = await prisma.usuario.findMany({
            where: {
                lojaId: req.lojaId,
                telefone: { contains: tail }
            },
            select: { nomeUsuario: true, telefone: true },
            take: 5
        });

        const candidates = [];
        const seen = new Set();

        for (const u of localUsers) {
            const key = `${u.nomeUsuario || ''}|${u.telefone || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({
                name: u.nomeUsuario || 'Cliente',
                phone: u.telefone || rawPhone,
                source: 'local'
            });
        }

        const zapi = await checkPhoneExistsWhatsApp(digits, req.lojaId);
        if (zapi?.success && zapi?.exists) {
            const response = zapi.response || {};
            const zapiName =
                response?.name ||
                response?.pushName ||
                response?.contactName ||
                response?.owner?.name ||
                response?.owner?.pushName ||
                null;

            if (zapiName) {
                const key = `${zapiName}|${digits}`;
                if (!seen.has(key)) {
                    candidates.unshift({
                        name: zapiName,
                        phone: rawPhone,
                        source: 'zapi'
                    });
                }
            }
        }

        return res.json({ candidates });
    } catch (error) {
        console.error('[GET /api/orders/balcao/customer-lookup] Erro:', error.message);
        return res.status(500).json({ message: 'Erro ao buscar cliente por telefone.', candidates: [] });
    }
});

// Rota para ver o histórico de pedidos do usuário
router.get('/history', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    console.log(`[GET /api/orders/history] Recebida requisição para o histórico de pedidos. Usuário ID: ${userId}`);
    
    try {
        const orders = await prisma.pedido.findMany({
            where: { usuarioId: userId, lojaId: req.lojaId },
            include: {
                mesa: { select: { id: true, nome: true } },
                itens_pedido: {
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
                },
                pagamento: true,
                cupom_pedido: {
                    include: {
                        cupom: {
                            select: {
                                id: true,
                                codigo: true
                            }
                        }
                    }
                }
            },
            orderBy: {
                criadoEm: 'desc'
            }
        });

        const dailyNumberMap = buildDailyNumberMap(orders);

        // Transformar os dados para o formato esperado pelo frontend
        const transformedOrders = orders.map(order => ({
            id: order.id,
            dailyNumber: dailyNumberMap.get(order.id) || null,
            userId: order.usuarioId,
            totalPrice: order.precoTotal,
            status: order.status,
            deliveryType: order.tipoEntrega,
            createdAt: order.criadoEm,
            onTheWayAt: order.saiuParaEntregaEm ?? null,
            preparationStartedAt: order.inicioPreparoEm ?? null,
            shippingStreet: order.ruaEntrega,
            shippingNumber: order.numeroEntrega,
            shippingComplement: order.complementoEntrega,
            shippingNeighborhood: order.bairroEntrega,
            shippingPhone: order.telefoneEntrega,
            shippingReference: order.referenciaEntrega || null,
            deliveryFee: order.taxaEntrega,
            notes: order.observacoes,
            precisaTroco: order.precisaTroco || false,
            valorTroco: order.valorTroco ? Number(order.valorTroco) : null,
            mesaId: order.mesaId ?? null,
            mesaNome: order.mesa?.nome ?? null,
            orderitem: order.itens_pedido.map(item => {
                // Parsear opcoesSelecionadasSnapshot para garantir que seja sempre um objeto
                const parsedSnapshot = parseOptionsSnapshot(item.opcoesSelecionadasSnapshot);
                
                return {
                    id: item.id,
                    orderId: item.pedidoId,
                    productId: item.produtoId,
                    quantity: item.quantidade,
                    priceAtOrder: item.precoNoPedido,
                    selectedOptionsSnapshot: parsedSnapshot,
                    complements: item.complementos ? item.complementos.map(c => ({
                        id: c.complemento.id,
                        name: c.complemento.nome,
                        imageUrl: c.complemento.imagemUrl,
                        isActive: c.complemento.ativo
                    })) : [],
                    additionals: item.adicionais ? item.adicionais.map(a => ({
                        id: a.adicional.id,
                        name: a.adicional.nome,
                        value: Number(a.adicional.valor),
                        quantity: a.quantidade || 1,
                        imageUrl: a.adicional.imagemUrl,
                        isActive: a.adicional.ativo
                    })) : [],
                    flavors: item.sabores ? item.sabores.map(s => ({
                        id: s.sabor.id,
                        name: s.sabor.nome,
                        imageUrl: s.sabor.imagemUrl,
                        isActive: s.sabor.ativo
                    })) : [],
                product: {
                    id: item.produto.id,
                    name: item.produto.nome,
                    price: item.produto.preco,
                    description: item.produto.descricao,
                    isActive: item.produto.ativo,
                    createdAt: item.produto.criadoEm,
                    categoryId: item.produto.categoriaId,
                    images: item.produto.imagens_produto?.map(img => ({
                        id: img.id,
                        url: img.url,
                        altText: img.textoAlt,
                        productId: img.produtoId
                    })) || []
                }
                };
            }),
            payment: order.pagamento ? {
                id: order.pagamento.id,
                amount: order.pagamento.valor,
                method: order.pagamento.metodo,
                status: order.pagamento.status,
                transactionId: order.pagamento.idTransacao,
                createdAt: order.pagamento.criadoEm,
                updatedAt: order.pagamento.atualizadoEm,
                orderId: order.pagamento.pedidoId
            } : null
        }));

        console.log(`[GET /api/orders/history] Histórico de pedidos do usuário ${userId} buscado com sucesso. Total de pedidos: ${transformedOrders.length}`);
        res.status(200).json(transformedOrders);
    } catch (err) {
        console.error(`[GET /api/orders/history] Erro ao buscar o histórico de pedidos para o usuário ${userId}:`, err.message);
        res.status(500).json({ message: 'Erro ao buscar o histórico de pedidos.', error: err.message });
    }
});

// Rota para atualizar o status de um pedido (admin/master/garçom)
router.put(
  '/status/:orderId',
  authenticateToken,
  async (req, res, next) => {
    const allowedRoles = ['admin', 'master', 'waiter'];
    const role = req.user?.funcao;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: 'Acesso negado: você não tem permissão para atualizar o status.' });
    }
    next();
  },
  async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const { status, delivererId } = req.body;
    console.log(`[PUT /api/orders/status/${orderId}] Recebida requisição de admin para atualizar status para: "${status}"`);

    // Adicione uma validação para garantir que o status é válido
    const validStatuses = ['pending_payment', 'being_prepared', 'ready_for_pickup', 'on_the_way', 'delivered', 'canceled'];
    if (!validStatuses.includes(status)) {
        console.warn(`[PUT /api/orders/status/${orderId}] Tentativa de usar status inválido: "${status}".`);
        return res.status(400).json({ message: 'Status inválido. Por favor, use um dos seguintes: ' + validStatuses.join(', ') });
    }

    try {
        // Buscar o pedido atual primeiro para comparar o status
        const currentOrder = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
            include: {
                pagamento: {
                    select: {
                        metodo: true
                    }
                }
            }
        });

        if (!currentOrder) {
            console.error(`[PUT /api/orders/status/${orderId}] Erro: Pedido não encontrado.`);
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }

        // Verificar se o entregador existe e está ativo (se fornecido)
        if (delivererId) {
            const deliverer = await prisma.entregador.findFirst({
                where: { id: parseInt(delivererId), lojaId: req.lojaId }
            });
            
            if (!deliverer || !deliverer.ativo) {
                console.warn(`[PUT /api/orders/status/${orderId}] Entregador não encontrado ou inativo. ID: ${delivererId}`);
                return res.status(400).json({ message: 'Entregador não encontrado ou inativo' });
            }
        }

        const updatedOrder = await prisma.pedido.update({
            where: { id: orderId },
            data: { 
                status: status,
                entregadorId: delivererId ? parseInt(delivererId) : undefined,
                atualizadoEm: new Date(),
                ...(currentOrder.status !== 'on_the_way' && status === 'on_the_way' ? { saiuParaEntregaEm: new Date() } : {}),
                ...patchInicioPreparoSeNecessario(currentOrder, status)
            },
            include: {
                itens_pedido: {
                    include: {
                        produto: true,
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
                },
                usuario: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                        email: true,
                        telefone: true
                    }
                },
                entregador: {
                    select: {
                        id: true,
                        nome: true,
                        telefone: true
                    }
                },
                pagamento: {
                    select: {
                        metodo: true
                    }
                }
            }
        });
        const becameBeingPrepared = currentOrder.status !== 'being_prepared' && status === 'being_prepared';

        // Calcular dailyNumber para usar nas notificações
        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        // Enviar notificação de pagamento confirmado se mudou de "pending_payment" para "being_prepared" (PIX)
        if (currentOrder.status === 'pending_payment' && status === 'being_prepared') {
            try {
                console.log('💳 Enviando notificação de pagamento confirmado...');
                // Buscar referência do endereço usado no pedido (não o padrão)
                // O endereço já está salvo no pedido, buscar a referência correspondente
                let referenciaEntrega = updatedOrder.referenciaEntrega || null;
                if (!referenciaEntrega && updatedOrder.ruaEntrega && updatedOrder.numeroEntrega) {
                    const enderecoUsado = await prisma.endereco.findFirst({
                        where: {
                            usuarioId: updatedOrder.usuarioId,
                            rua: updatedOrder.ruaEntrega,
                            numero: updatedOrder.numeroEntrega,
                            bairro: updatedOrder.bairroEntrega
                    }
                });
                    referenciaEntrega = enderecoUsado?.pontoReferencia || null;
                }
                const orderWithReference = {
                    ...updatedOrder,
                    referenciaEntrega: referenciaEntrega
                };
                await sendPaymentConfirmationNotification(orderWithReference);
                
                // Notificar todos os cozinheiros quando pedido entra em preparo
                console.log('👨‍🍳 Notificando todos os cozinheiros ativos');
                await sendCookNotification(updatedOrder);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de pagamento confirmado:', error);
                // Não falha a operação se as notificações falharem
            }
        }

        if (becameBeingPrepared) {
            triggerAutoPrint(updatedOrder, 'status_changed_to_being_prepared');
            await publishEvent(updatedOrder.lojaId, 'ORDER_BEING_PREPARED', updatedOrder);
        }

        const previousDelivererIdStatusRoute = currentOrder.entregadorId ?? null;
        const newDelivererIdFromBody = delivererId !== undefined
            ? (delivererId ? parseInt(String(delivererId), 10) : null)
            : previousDelivererIdStatusRoute;
        const becameOnTheWayStatusRoute = currentOrder.status !== 'on_the_way' && status === 'on_the_way';
        const delivererReassignedStatusRoute = delivererId !== undefined
            && newDelivererIdFromBody !== previousDelivererIdStatusRoute;

        // Enviar notificações ao entrar em "on_the_way" ou ao trocar o entregador (reenvio WhatsApp)
        if (status === 'on_the_way' && updatedOrder.tipoEntrega === 'delivery' && updatedOrder.entregador && (becameOnTheWayStatusRoute || delivererReassignedStatusRoute)) {
            try {
                console.log('📱 Enviando notificações de entrega...');
                // Buscar referência do endereço usado no pedido (não o padrão)
                let referenciaEntrega = updatedOrder.referenciaEntrega || null;
                if (!referenciaEntrega && updatedOrder.ruaEntrega && updatedOrder.numeroEntrega) {
                    const enderecoUsado = await prisma.endereco.findFirst({
                        where: {
                            usuarioId: updatedOrder.usuarioId,
                            rua: updatedOrder.ruaEntrega,
                            numero: updatedOrder.numeroEntrega,
                            bairro: updatedOrder.bairroEntrega
                    }
                });
                    referenciaEntrega = enderecoUsado?.pontoReferencia || null;
                }
                
                // Mapear campos para compatibilidade com messageService
                const orderForNotification = {
                    ...updatedOrder,
                    totalPrice: updatedOrder.precoTotal,
                    user: updatedOrder.usuario ? {
                        username: updatedOrder.usuario.nomeUsuario,
                        phone: updatedOrder.usuario.telefone
                    } : null,
                    orderItems: updatedOrder.itens_pedido.map(item => ({
                        ...item,
                        product: item.produto // garantir campo 'product' (inglês)
                    })),
                    shippingStreet: updatedOrder.ruaEntrega,
                    shippingNumber: updatedOrder.numeroEntrega,
                    shippingComplement: updatedOrder.complementoEntrega,
                    shippingNeighborhood: updatedOrder.bairroEntrega,
                    shippingReference: referenciaEntrega,
                    shippingPhone: updatedOrder.usuario?.telefone
                };
                await sendDeliveryNotifications(orderForNotification, updatedOrder.entregador);
            } catch (error) {
                console.error('❌ Erro ao enviar notificações:', error);
                // Não falha a operação se as notificações falharem
            }
        }

        // Enviar notificação de cancelamento se o status mudou para "canceled"
        if (status === 'canceled' && currentOrder.status !== 'canceled') {
            try {
                console.log('❌ Enviando notificação de cancelamento ao cliente...');
                await sendOrderCancellationNotification(updatedOrder);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de cancelamento:', error);
                // Não falha a operação se a notificação falhar
            }
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[PUT /api/orders/status/${orderId}] Status do pedido atualizado com sucesso para "${updatedOrder.status}".`);
        res.status(200).json({ message: 'Status do pedido atualizado com sucesso!', order: orderWithParsedOptions });
    } catch (err) {
        if (err.code === 'P2025') { // Erro de registro não encontrado
            console.error(`[PUT /api/orders/status/${orderId}] Erro: Pedido não encontrado.`);
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }
        console.error(`[PUT /api/orders/status/${orderId}] Erro ao atualizar o status do pedido:`, err.message);
        res.status(500).json({ message: 'Erro ao atualizar o status do pedido.', error: err.message });
    }
});

// Rota para atualizar o valor total do pedido (apenas admin) - DEVE VIR ANTES DA ROTA GENÉRICA
router.put('/:orderId/update-total', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const { totalPrice } = req.body;
    console.log(`[PUT /api/orders/${orderId}/update-total] Atualizando valor total do pedido para: R$ ${totalPrice}`);

    try {
        if (!totalPrice || totalPrice <= 0) {
            return res.status(400).json({ message: 'Valor total inválido' });
        }

        const order = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
            include: {
                itens_pedido: {
                    include: {
                        produto: true,
                        complementos: {
                            include: {
                                complemento: true
                            }
                        }
                    }
                },
                usuario: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                        email: true,
                        telefone: true
                    }
                }
            }
        });

        if (!order) {
            return res.status(404).json({ message: 'Pedido não encontrado' });
        }

        // Capturar valor antigo antes de atualizar
        const oldTotal = parseFloat(order.precoTotal);
        const newTotal = parseFloat(totalPrice);

        // Atualizar valor do pedido e pagamento
        const updatedOrder = await prisma.$transaction(async (tx) => {
            // Atualizar pedido
            const updated = await tx.pedido.update({
                where: { id: orderId },
                data: {
                    precoTotal: newTotal,
                    atualizadoEm: new Date()
                },
                include: {
                    itens_pedido: {
                        include: {
                            produto: true,
                            complementos: {
                                include: {
                                    complemento: true
                                }
                            }
                        }
                    },
                    usuario: {
                        select: {
                            id: true,
                            nomeUsuario: true,
                            email: true,
                            telefone: true
                        }
                    },
                    pagamento: true
                }
            });

            // Atualizar pagamento se existir
            if (updated.pagamento) {
                await tx.pagamento.update({
                    where: { pedidoId: orderId },
                    data: {
                        valor: newTotal,
                        atualizadoEm: new Date()
                    }
                });
            }

            return updated;
        });

        // Calcular dailyNumber para notificação
        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        // Enviar notificação ao cliente se o valor foi alterado
        if (oldTotal !== newTotal) {
            try {
                console.log(`📱 [PUT /api/orders/${orderId}/update-total] Enviando notificação de edição ao cliente...`);
                const editReason = `O valor do pedido foi ajustado de R$ ${oldTotal.toFixed(2)} para R$ ${newTotal.toFixed(2)}.`;
                await sendOrderEditNotification(updatedOrder, oldTotal, newTotal, editReason);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de edição:', error);
                // Não falha a operação se a notificação falhar
            }
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[PUT /api/orders/${orderId}/update-total] Valor atualizado com sucesso`);
        res.status(200).json({ message: 'Valor do pedido atualizado com sucesso!', data: orderWithParsedOptions });
    } catch (error) {
        console.error(`[PUT /api/orders/${orderId}/update-total] Erro:`, error.message);
        res.status(500).json({ message: 'Erro ao atualizar valor do pedido', error: error.message });
    }
});

// Rota para adicionar item ao pedido (apenas admin) - DEVE VIR ANTES DA ROTA GENÉRICA
router.post('/:orderId/add-item', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const { productId, quantity, complementIds, flavorIds, price } = req.body;
    console.log(`[POST /api/orders/${orderId}/add-item] Adicionando item ao pedido`);

    try {
        if (!productId || !quantity || quantity <= 0) {
            return res.status(400).json({ message: 'Dados inválidos' });
        }

        const order = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
            include: { itens_pedido: true }
        });

        if (!order) {
            return res.status(404).json({ message: 'Pedido não encontrado' });
        }

        // Verificar se o produto existe
        const product = await prisma.produto.findFirst({
            where: { id: productId, lojaId: req.lojaId }
        });

        if (!product) {
            return res.status(404).json({ message: 'Produto não encontrado' });
        }

        // Usar preço fornecido ou preço do produto
        const itemPrice = price ? parseFloat(price) : parseFloat(product.preco);
        
        // Capturar valor antigo antes de atualizar
        const oldTotal = parseFloat(order.precoTotal);

        const updatedOrder = await prisma.$transaction(async (tx) => {
            // Adicionar item ao pedido
            const newItem = await tx.item_pedido.create({
                data: {
                    pedidoId: orderId,
                    produtoId: productId,
                    quantidade: parseInt(quantity),
                    precoNoPedido: itemPrice
                }
            });

            // Adicionar complementos se fornecidos
            if (complementIds && Array.isArray(complementIds) && complementIds.length > 0) {
                await Promise.all(
                    complementIds.map(complementId =>
                        tx.item_pedido_complemento.create({
                            data: {
                                itemPedidoId: newItem.id,
                                complementoId: complementId
                            }
                        })
                    )
                );
            }

            // Adicionar sabores se fornecidos
            if (flavorIds && Array.isArray(flavorIds) && flavorIds.length > 0) {
                await Promise.all(
                    flavorIds.map(saborId =>
                        tx.item_pedido_sabor.create({
                            data: {
                                itemPedidoId: newItem.id,
                                saborId: saborId
                            }
                        })
                    )
                );
            }

            // Somar o valor do novo item ao valor atual do pedido (que pode ter sido editado manualmente)
            const itemValue = itemPrice * parseInt(quantity);
            const currentTotal = parseFloat(order.precoTotal);
            const newTotal = currentTotal + itemValue;

            // Atualizar pedido
            const updated = await tx.pedido.update({
                where: { id: orderId },
                data: {
                    precoTotal: newTotal,
                    atualizadoEm: new Date()
                },
                include: {
                    itens_pedido: {
                        include: {
                            produto: true,
                            complementos: {
                                include: {
                                    complemento: true
                                }
                            }
                        }
                    },
                    usuario: {
                        select: {
                            id: true,
                            nomeUsuario: true,
                            email: true,
                            telefone: true
                        }
                    },
                    pagamento: true
                }
            });

            // Atualizar pagamento se existir
            if (updated.pagamento) {
                await tx.pagamento.update({
                    where: { pedidoId: orderId },
                    data: {
                        valor: newTotal,
                        atualizadoEm: new Date()
                    }
                });
            }

            return updated;
        });

        // Calcular dailyNumber para notificação
        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        // Enviar notificação ao cliente se o valor foi alterado
        const newTotal = parseFloat(updatedOrder.precoTotal);
        if (oldTotal !== newTotal) {
            try {
                console.log(`📱 [POST /api/orders/${orderId}/add-item] Enviando notificação de edição ao cliente...`);
                const editReason = `Um item foi adicionado ao seu pedido. O valor foi ajustado de R$ ${oldTotal.toFixed(2)} para R$ ${newTotal.toFixed(2)}.`;
                await sendOrderEditNotification(updatedOrder, oldTotal, newTotal, editReason);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de edição:', error);
                // Não falha a operação se a notificação falhar
            }
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[POST /api/orders/${orderId}/add-item] Item adicionado com sucesso`);
        res.status(200).json({ message: 'Item adicionado ao pedido com sucesso!', data: orderWithParsedOptions });
    } catch (error) {
        console.error(`[POST /api/orders/${orderId}/add-item] Erro:`, error.message);
        res.status(500).json({ message: 'Erro ao adicionar item ao pedido', error: error.message });
    }
});

// Rota para atualizar apenas a quantidade de um item (mantém sabores/complementos/adicionais)
router.put('/:orderId/update-item-quantity/:itemId', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const itemId = parseInt(req.params.itemId);
    const quantity = parseInt(req.body?.quantity);
    console.log(`[PUT /api/orders/${orderId}/update-item-quantity/${itemId}] Atualizando quantidade do item para ${quantity}`);

    try {
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({ message: 'Quantidade inválida' });
        }

        const order = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
            include: {
                itens_pedido: true,
                pagamento: true
            }
        });

        if (!order) {
            return res.status(404).json({ message: 'Pedido não encontrado' });
        }

        const item = order.itens_pedido.find(i => i.id === itemId);
        if (!item) {
            return res.status(404).json({ message: 'Item não encontrado no pedido' });
        }

        const currentQuantity = Number(item.quantidade || 0);
        if (currentQuantity === quantity) {
            return res.status(200).json({ message: 'Quantidade inalterada' });
        }

        const oldTotal = parseFloat(order.precoTotal);
        const unitPrice = parseFloat(item.precoNoPedido || 0);
        const oldItemTotal = unitPrice * currentQuantity;
        const newItemTotal = unitPrice * quantity;
        const newTotal = oldTotal - oldItemTotal + newItemTotal;

        const updatedOrder = await prisma.$transaction(async (tx) => {
            await tx.item_pedido.update({
                where: { id: itemId },
                data: { quantidade: quantity }
            });

            const updated = await tx.pedido.update({
                where: { id: orderId },
                data: {
                    precoTotal: newTotal,
                    atualizadoEm: new Date()
                },
                include: {
                    itens_pedido: {
                        include: {
                            produto: true,
                            complementos: {
                                include: {
                                    complemento: true
                                }
                            }
                        }
                    },
                    usuario: {
                        select: {
                            id: true,
                            nomeUsuario: true,
                            email: true,
                            telefone: true
                        }
                    },
                    pagamento: true
                }
            });

            if (updated.pagamento) {
                await tx.pagamento.update({
                    where: { pedidoId: orderId },
                    data: {
                        valor: newTotal,
                        atualizadoEm: new Date()
                    }
                });
            }

            return updated;
        });

        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        if (oldTotal !== newTotal) {
            try {
                console.log(`📱 [PUT /api/orders/${orderId}/update-item-quantity/${itemId}] Enviando notificação de edição ao cliente...`);
                const editReason = `A quantidade de um item do seu pedido foi alterada de ${currentQuantity}x para ${quantity}x. O valor foi ajustado de R$ ${oldTotal.toFixed(2)} para R$ ${newTotal.toFixed(2)}.`;
                await sendOrderEditNotification(updatedOrder, oldTotal, newTotal, editReason);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de edição:', error);
            }
        }

        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };

        console.log(`[PUT /api/orders/${orderId}/update-item-quantity/${itemId}] Quantidade atualizada com sucesso`);
        res.status(200).json({ message: 'Quantidade do item atualizada com sucesso!', data: orderWithParsedOptions });
    } catch (error) {
        console.error(`[PUT /api/orders/${orderId}/update-item-quantity/${itemId}] Erro:`, error.message);
        res.status(500).json({ message: 'Erro ao atualizar quantidade do item', error: error.message });
    }
});

// Rota para remover item do pedido (apenas admin) - DEVE VIR ANTES DA ROTA GENÉRICA
router.delete('/:orderId/remove-item/:itemId', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const itemId = parseInt(req.params.itemId);
    console.log(`[DELETE /api/orders/${orderId}/remove-item/${itemId}] Removendo item do pedido`);

    try {
        const order = await prisma.pedido.findUnique({
            where: { id: orderId },
            include: { itens_pedido: true }
        });

        if (!order) {
            return res.status(404).json({ message: 'Pedido não encontrado' });
        }

        const item = order.itens_pedido.find(i => i.id === itemId);
        if (!item) {
            return res.status(404).json({ message: 'Item não encontrado no pedido' });
        }

        // Capturar valor antigo antes de atualizar
        const oldTotal = parseFloat(order.precoTotal);

        const updatedOrder = await prisma.$transaction(async (tx) => {
            // Remover complementos do item primeiro
            await tx.item_pedido_complemento.deleteMany({
                where: { itemPedidoId: itemId }
            });
            
            // Remover sabores do item
            await tx.item_pedido_sabor.deleteMany({
                where: { itemPedidoId: itemId }
            });

            // Calcular o valor do item que será removido antes de removê-lo
            const itemValue = parseFloat(item.precoNoPedido) * item.quantidade;
            
            // Remover item
            await tx.item_pedido.delete({
                where: { id: itemId }
            });

            // Subtrair o valor do item removido do total atual do pedido (que pode ter sido editado manualmente)
            const currentTotal = parseFloat(order.precoTotal);
            const newTotal = currentTotal - itemValue;

            // Atualizar pedido
            const updated = await tx.pedido.update({
                where: { id: orderId },
                data: {
                    precoTotal: newTotal,
                    atualizadoEm: new Date()
                },
                include: {
                    itens_pedido: {
                        include: {
                            produto: true,
                            complementos: {
                                include: {
                                    complemento: true
                                }
                            }
                        }
                    },
                    usuario: {
                        select: {
                            id: true,
                            nomeUsuario: true,
                            email: true,
                            telefone: true
                        }
                    },
                    pagamento: true
                }
            });

            // Atualizar pagamento se existir
            if (updated.pagamento) {
                await tx.pagamento.update({
                    where: { pedidoId: orderId },
                    data: {
                        valor: newTotal,
                        atualizadoEm: new Date()
                    }
                });
            }

            return updated;
        });

        // Calcular dailyNumber para notificação
        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        // Enviar notificação ao cliente se o valor foi alterado
        const newTotal = parseFloat(updatedOrder.precoTotal);
        if (oldTotal !== newTotal) {
            try {
                console.log(`📱 [DELETE /api/orders/${orderId}/remove-item/${itemId}] Enviando notificação de edição ao cliente...`);
                const editReason = `Um item foi removido do seu pedido. O valor foi ajustado de R$ ${oldTotal.toFixed(2)} para R$ ${newTotal.toFixed(2)}.`;
                await sendOrderEditNotification(updatedOrder, oldTotal, newTotal, editReason);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de edição:', error);
                // Não falha a operação se a notificação falhar
            }
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[DELETE /api/orders/${orderId}/remove-item/${itemId}] Item removido com sucesso`);
        res.status(200).json({ message: 'Item removido do pedido com sucesso!', data: orderWithParsedOptions });
    } catch (error) {
        console.error(`[DELETE /api/orders/${orderId}/remove-item/${itemId}] Erro:`, error.message);
        res.status(500).json({ message: 'Erro ao remover item do pedido', error: error.message });
    }
});

// Nova rota PUT para compatibilidade com o frontend (/orders/:orderId)
router.put('/:orderId', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const { status, delivererId } = req.body;
    console.log(`[PUT /api/orders/${orderId}] Recebida requisição de admin para atualizar pedido. Status: "${status}", Entregador: ${delivererId}`);

    try {
        // Verificar se o pedido existe
        const existingOrder = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId }
        });

        if (!existingOrder) {
            console.error(`[PUT /api/orders/${orderId}] Erro: Pedido não encontrado.`);
            return res.status(404).json({ message: 'Pedido não encontrado' });
        }

        // Mapear status do frontend para formato do banco
        const statusMapping = {
            'pending_payment': 'pending_payment',
            'being_prepared': 'being_prepared', 
            'on_the_way': 'on_the_way',
            'delivered': 'delivered',
            'canceled': 'canceled'
        };

        let dbStatus = status;
        if (status && statusMapping[status]) {
            dbStatus = statusMapping[status];
            console.log(`[PUT /api/orders/${orderId}] Status validado: "${status}" -> "${dbStatus}"`);
        }

        // Validar status se fornecido
        const validStatuses = ['pending_payment', 'being_prepared', 'ready_for_pickup', 'on_the_way', 'delivered', 'canceled'];
        if (dbStatus && !validStatuses.includes(dbStatus)) {
            console.warn(`[PUT /api/orders/${orderId}] Status inválido: "${dbStatus}".`);
            return res.status(400).json({ message: 'Status inválido' });
        }

        // Validar entregador se fornecido
        if (delivererId) {
            const deliverer = await prisma.entregador.findFirst({
                where: { id: parseInt(delivererId), lojaId: req.lojaId }
            });
            
            if (!deliverer || !deliverer.ativo) {
                console.warn(`[PUT /api/orders/${orderId}] Entregador não encontrado ou inativo. ID: ${delivererId}`);
                return res.status(400).json({ message: 'Entregador não encontrado ou inativo' });
            }
        }

        // Validação: NENHUM pedido pode ser cancelado se estiver a caminho, pronto para retirada ou entregue
        if (dbStatus === 'canceled' && (existingOrder.status === 'on_the_way' || existingOrder.status === 'ready_for_pickup' || existingOrder.status === 'delivered')) {
            console.warn(`[PUT /api/orders/${orderId}] Não é possível cancelar. Status atual: "${existingOrder.status}".`);
            return res.status(400).json({ message: `Não é possível cancelar um pedido com o status "${existingOrder.status}".` });
        }

        const nextStatus = dbStatus || existingOrder.status;

        // Atualizar pedido
        const order = await prisma.pedido.update({
            where: { id: orderId },
            data: {
                status: nextStatus,
                entregadorId: delivererId !== undefined ? (delivererId ? parseInt(delivererId) : null) : existingOrder.entregadorId,
                atualizadoEm: new Date(),
                ...(existingOrder.status !== 'on_the_way' && nextStatus === 'on_the_way' ? { saiuParaEntregaEm: new Date() } : {}),
                ...patchInicioPreparoSeNecessario(existingOrder, nextStatus)
            },
            include: {
                itens_pedido: {
                    include: {
                        produto: true,
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
                },
                usuario: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                        email: true,
                        telefone: true
                    }
                },
                entregador: {
                    select: {
                        id: true,
                        nome: true,
                        telefone: true
                    }
                },
                pagamento: {
                    select: {
                        metodo: true
                    }
                }
            }
        });

        // Calcular dailyNumber para usar nas notificações
        order.dailyNumber = await getDailyNumber(order.id, order.lojaId, order.criadoEm);

        // Enviar notificação de pagamento confirmado se mudou de "pending_payment" para "being_prepared" (PIX)
        if (existingOrder.status === 'pending_payment' && dbStatus === 'being_prepared') {
            try {
                console.log('💳 Enviando notificação de pagamento confirmado...');
                // Buscar referência do endereço usado no pedido (não o padrão)
                let referenciaEntrega = order.referenciaEntrega || null;
                if (!referenciaEntrega && order.ruaEntrega && order.numeroEntrega) {
                    const enderecoUsado = await prisma.endereco.findFirst({
                        where: {
                            usuarioId: order.usuarioId,
                            rua: order.ruaEntrega,
                            numero: order.numeroEntrega,
                            bairro: order.bairroEntrega
                    }
                });
                    referenciaEntrega = enderecoUsado?.pontoReferencia || null;
                }
                const orderWithReference = {
                    ...order,
                    referenciaEntrega: referenciaEntrega
                };
                await sendPaymentConfirmationNotification(orderWithReference);
                // Notificar todos os cozinheiros quando pedido entra em preparo
                console.log('👨‍🍳 Notificando todos os cozinheiros ativos');
                await sendCookNotification(order);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de pagamento confirmado:', error);
                // Não falha a operação se as notificações falharem
            }
        }

        const becameBeingPreparedOnEdit = existingOrder.status !== 'being_prepared' && dbStatus === 'being_prepared';
        if (becameBeingPreparedOnEdit) {
            triggerAutoPrint(order, 'order_edited_to_being_prepared');
            await publishEvent(order.lojaId, 'ORDER_BEING_PREPARED', order);
        }

        // Enviar confirmação de entrega ao cliente se status for 'delivered'
        if (dbStatus === 'delivered') {
            try {
                console.log('📦 Enviando confirmação de entrega ao cliente...');
                await sendDeliveredConfirmationNotification(order);
            } catch (error) {
                console.error('❌ Erro ao enviar confirmação de entrega:', error);
            }
        }

        // Enviar notificação de cancelamento se o status mudou para "canceled"
        if (dbStatus === 'canceled' && existingOrder.status !== 'canceled') {
            try {
                console.log('❌ Enviando notificação de cancelamento ao cliente...');
                // Buscar dados completos do pedido com itens e complementos
                const orderWithItems = await prisma.pedido.findFirst({
                    where: { id: orderId, lojaId: req.lojaId },
                    include: {
                        itens_pedido: {
                            include: {
                                produto: true,
                                complementos: {
                                    include: {
                                        complemento: true
                                    }
                                }
                            }
                        },
                        usuario: {
                            select: {
                                id: true,
                                nomeUsuario: true,
                                email: true,
                                telefone: true
                            }
                        },
                        pagamento: {
                            select: {
                                metodo: true
                            }
                        }
                    }
                });
                orderWithItems.dailyNumber = order.dailyNumber;
                await sendOrderCancellationNotification(orderWithItems);
            } catch (error) {
                console.error('❌ Erro ao enviar notificação de cancelamento:', error);
                // Não falha a operação se a notificação falhar
            }
        }

        const previousDelivererId = existingOrder.entregadorId ?? null;
        const newDelivererIdResolved = delivererId !== undefined
            ? (delivererId ? parseInt(String(delivererId), 10) : null)
            : previousDelivererId;
        const becameOnTheWay = existingOrder.status !== 'on_the_way' && dbStatus === 'on_the_way';
        const delivererReassigned = delivererId !== undefined
            && newDelivererIdResolved !== previousDelivererId;

        // Enviar notificações baseadas no tipo de pedido e status (primeira vez a caminho ou troca de entregador)
        if (dbStatus === 'on_the_way' && order.entregador && order.tipoEntrega === 'delivery' && (becameOnTheWay || delivererReassigned)) {
            // Notificação para entrega com entregador
            try {
                console.log('📱 Enviando notificações de entrega...');
                // Buscar referência do endereço usado no pedido (não o padrão)
                let referenciaEntrega = order.referenciaEntrega || null;
                if (!referenciaEntrega && order.ruaEntrega && order.numeroEntrega) {
                    const enderecoUsado = await prisma.endereco.findFirst({
                        where: {
                            usuarioId: order.usuarioId,
                            rua: order.ruaEntrega,
                            numero: order.numeroEntrega,
                            bairro: order.bairroEntrega
                    }
                });
                    referenciaEntrega = enderecoUsado?.pontoReferencia || null;
                }
                
                // Mapear campos para compatibilidade com messageService
                const orderForNotification = {
                    ...order,
                    totalPrice: order.precoTotal,
                    user: order.usuario ? {
                        username: order.usuario.nomeUsuario,
                        phone: order.usuario.telefone
                    } : null,
                    orderItems: order.itens_pedido.map(item => ({
                        ...item,
                        product: item.produto // garantir campo 'product' (inglês)
                    })),
                    shippingStreet: order.ruaEntrega,
                    shippingNumber: order.numeroEntrega,
                    shippingComplement: order.complementoEntrega,
                    shippingNeighborhood: order.bairroEntrega,
                    shippingReference: referenciaEntrega,
                    shippingPhone: order.usuario?.telefone
                };
                await sendDeliveryNotifications(orderForNotification, order.entregador);
            } catch (error) {
                console.error('❌ Erro ao enviar notificações de entrega:', error);
            }
        } else if (dbStatus === 'ready_for_pickup' && (order.tipoEntrega === 'pickup' || order.tipoEntrega === 'dine_in')) {
                        // Notificação para retirada
                        try {
                                console.log('🏪 Enviando notificação de retirada...');
                                // Mapear campos para compatibilidade com messageService
                                const orderForNotification = {
                                    ...order,
                                    totalPrice: order.precoTotal,
                                    deliveryType: order.tipoEntrega,
                                    paymentMethod: order.metodoPagamento,
                                    user: order.usuario ? {
                                        username: order.usuario.nomeUsuario,
                                        phone: order.usuario.telefone
                                    } : null,
                                    orderItems: order.itens_pedido,
                                    shippingStreet: order.ruaEntrega,
                                    shippingNumber: order.numeroEntrega,
                                    shippingComplement: order.complementoEntrega,
                                    shippingNeighborhood: order.bairroEntrega,
                                    shippingPhone: order.usuario?.telefone
                                };
                                await sendPickupNotification(orderForNotification);
                        } catch (error) {
                                console.error('❌ Erro ao enviar notificação de retirada:', error);
                        }
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...order,
            itens_pedido: order.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[PUT /api/orders/${orderId}] Pedido atualizado com sucesso.`);
        res.json(orderWithParsedOptions);
    } catch (error) {
        console.error(`[PUT /api/orders/${orderId}] Erro ao atualizar pedido:`, error);
        res.status(500).json({ message: 'Erro interno do servidor' });
    }
});

// Rota para cancelar um pedido
router.put('/cancel/:orderId', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const userRole = req.user.funcao; // Corrigido: usar 'funcao' em vez de 'role'
    const orderId = parseInt(req.params.orderId);
    console.log(`[PUT /api/orders/cancel/${orderId}] Recebida requisição para cancelar pedido. Usuário ID: ${userId}, Função: ${userRole}`);

    try {
        const order = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
        });

        if (!order) {
            console.warn(`[PUT /api/orders/cancel/${orderId}] Pedido não encontrado.`);
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }

        // Verifica se o usuário é o dono do pedido ou um administrador
        if (order.usuarioId !== userId && userRole !== 'admin' && userRole !== 'master') {
            console.warn(`[PUT /api/orders/cancel/${orderId}] Acesso negado. Usuário ID ${userId} (${userRole}) tentou cancelar pedido que não lhe pertence (pedido do usuário ${order.usuarioId}).`);
            return res.status(403).json({ message: 'Acesso negado: você não tem permissão para cancelar este pedido.' });
        }
        
        // Se o pedido já está cancelado, não há nada a fazer
        if (order.status === 'canceled') {
            console.warn(`[PUT /api/orders/cancel/${orderId}] Pedido já está cancelado.`);
            return res.status(400).json({ message: 'Este pedido já está cancelado.' });
        }
        
        // Verifica se o status do pedido permite o cancelamento
        // NENHUM pedido pode ser cancelado se estiver a caminho, pronto para retirada ou entregue (mesmo por admins)
        if (order.status === 'on_the_way' || order.status === 'ready_for_pickup' || order.status === 'delivered') {
            console.warn(`[PUT /api/orders/cancel/${orderId}] Não é possível cancelar. Status atual: "${order.status}".`);
            return res.status(400).json({ message: `Não é possível cancelar um pedido com o status "${order.status}".` });
        }

        if (order.status === 'pending_payment' && userRole !== 'admin' && userRole !== 'master') {
            const storeConfig = await prisma.configuracao_loja.findUnique({
                where: { lojaId: req.lojaId },
                select: { cancelamentoPagamentoPendenteAtivo: true }
            });
            const cancelamentoAtivo = storeConfig?.cancelamentoPagamentoPendenteAtivo ?? true;
            if (!cancelamentoAtivo) {
                console.warn(`[PUT /api/orders/cancel/${orderId}] Cancelamento de pedido pendente desativado para usuário comum.`);
                return res.status(403).json({ message: 'O cancelamento de pedidos com pagamento pendente está desativado pela loja.' });
            }
        }

        const updatedOrder = await prisma.pedido.update({
            where: { id: orderId },
            data: { 
                status: 'canceled',
                atualizadoEm: new Date()
            },
            include: {
                itens_pedido: {
                    include: {
                        produto: true,
                        complementos: {
                            include: {
                                complemento: true
                            }
                        }
                    }
                },
                usuario: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                        email: true,
                        telefone: true
                    }
                },
                pagamento: {
                    select: {
                        metodo: true
                    }
                }
            }
        });

        // Calcular dailyNumber para notificação
        updatedOrder.dailyNumber = await getDailyNumber(updatedOrder.id, updatedOrder.lojaId, updatedOrder.criadoEm);

        // Enviar notificação de cancelamento ao cliente
        try {
            console.log('❌ Enviando notificação de cancelamento ao cliente...');
            await sendOrderCancellationNotification(updatedOrder);
        } catch (error) {
            console.error('❌ Erro ao enviar notificação de cancelamento:', error);
            // Não falha a operação se a notificação falhar
        }

        // Garantir que opcoesSelecionadasSnapshot seja parseado em todos os itens antes de retornar
        const orderWithParsedOptions = {
            ...updatedOrder,
            itens_pedido: updatedOrder.itens_pedido.map(item => ({
                ...item,
                opcoesSelecionadasSnapshot: parseOptionsSnapshot(item.opcoesSelecionadasSnapshot)
            }))
        };
        
        console.log(`[PUT /api/orders/cancel/${orderId}] Pedido cancelado com sucesso. Pedido ID: ${updatedOrder.id}`);
        res.status(200).json({ message: 'Pedido cancelado com sucesso!', order: orderWithParsedOptions });
    } catch (err) {
        console.error(`[PUT /api/orders/cancel/${orderId}] Erro ao cancelar o pedido:`, err.message);
        res.status(500).json({ message: 'Erro ao cancelar o pedido.', error: err.message });
    }
});

// Rota para excluir um pedido permanentemente (apenas admin)
router.delete('/:orderId', authenticateToken, authorize('admin'), async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    console.log(`[DELETE /api/orders/${orderId}] Recebida requisição para excluir pedido permanentemente`);

    try {
        const order = await prisma.pedido.findFirst({
            where: { id: orderId, lojaId: req.lojaId },
            include: {
                itens_pedido: true
            }
        });

        if (!order) {
            console.warn(`[DELETE /api/orders/${orderId}] Pedido não encontrado.`);
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }

        // Excluir pedido e todos os dados relacionados em uma transação
        await prisma.$transaction(async (tx) => {
            // Excluir complementos dos itens primeiro
            for (const item of order.itens_pedido) {
                await tx.item_pedido_complemento.deleteMany({
                    where: { itemPedidoId: item.id }
                });
                await tx.item_pedido_sabor.deleteMany({
                    where: { itemPedidoId: item.id }
                });
            }

            // Excluir itens do pedido
            await tx.item_pedido.deleteMany({
                where: { pedidoId: orderId }
            });

            // Excluir pagamento se existir
            await tx.pagamento.deleteMany({
                where: { pedidoId: orderId }
            });

            // Excluir o pedido
            await tx.pedido.delete({
                where: { id: orderId }
            });
        });

        console.log(`[DELETE /api/orders/${orderId}] Pedido excluído permanentemente com sucesso.`);
        res.status(200).json({ message: 'Pedido excluído permanentemente com sucesso!' });
    } catch (err) {
        console.error(`[DELETE /api/orders/${orderId}] Erro ao excluir o pedido:`, err.message);
        res.status(500).json({ message: 'Erro ao excluir o pedido.', error: err.message });
    }
});

// Listar todos os pedidos (admin/master/garçom)
router.get(
  '/orders',
  authenticateToken,
  async (req, res, next) => {
    const allowedRoles = ['admin', 'master', 'waiter'];
    const role = req.user?.funcao;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: 'Acesso negado: você não tem permissão para listar pedidos.' });
    }
    next();
  },
  async (req, res) => {
    try {
        const orders = await prisma.pedido.findMany({
            where: { lojaId: req.lojaId },
            include: {
                mesa: { select: { id: true, nome: true } },
                entregador: {
                    select: {
                        id: true,
                        nome: true,
                    },
                },
                criadoPor: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                    },
                },
                usuario: {
                    select: {
                        id: true,
                        nomeUsuario: true,
                        email: true,
                        telefone: true,
                        enderecos: {
                            where: {
                                padrao: true
                            },
                            select: {
                                id: true,
                                rua: true,
                                numero: true,
                                complemento: true,
                                bairro: true,
                                padrao: true
                            }
                        }
                    }
                },
                itens_pedido: {
                    include: { 
                        produto: {
                            include: {
                                imagens_produto: true
                            }
                        },
                        complementos: {
                            include: {
                                complemento: {
                                    select: {
                                        id: true,
                                        nome: true,
                                        imagemUrl: true
                                    }
                                }
                            }
                        },
                        adicionais: {
                            include: {
                                adicional: {
                                    select: {
                                        id: true,
                                        nome: true,
                                        valor: true,
                                        imagemUrl: true,
                                        ativo: true
                                    }
                                }
                            }
                        },
                        sabores: {
                            include: {
                                sabor: {
                                    select: {
                                        id: true,
                                        nome: true,
                                        imagemUrl: true,
                                        ativo: true
                                    }
                                }
                            }
                        }
                    }
                },
                pagamento: true
            },
            orderBy: {
                criadoEm: 'desc'
            }
        });

        const dailyNumberMap = buildDailyNumberMap(orders);

        // Transformar os dados para o formato esperado pelo frontend
        const transformedOrders = orders.map(order => ({
            id: order.id,
            dailyNumber: dailyNumberMap.get(order.id) || null,
            userId: order.usuarioId,
            totalPrice: order.precoTotal,
            status: order.status,
            deliveryType: order.tipoEntrega,
            delivererId: order.entregadorId || null,
            delivererName: order.entregador?.nome || null,
            paymentMethod: order.metodoPagamento,
            onTheWayAt: order.saiuParaEntregaEm ?? null,
            orderCoupon: order.cupom_pedido ? {
                id: order.cupom_pedido.id,
                couponId: order.cupom_pedido.cupomId,
                discountAmount: Number(order.cupom_pedido.valorDesconto || 0),
                coupon: {
                    id: order.cupom_pedido.cupom?.id,
                    code: order.cupom_pedido.cupom?.codigo || ''
                }
            } : null,
            createdAt: order.criadoEm,
            updatedAt: order.atualizadoEm,
            preparationStartedAt: order.inicioPreparoEm ?? null,
            shippingStreet: order.ruaEntrega,
            shippingNumber: order.numeroEntrega,
            shippingComplement: order.complementoEntrega,
            shippingNeighborhood: order.bairroEntrega,
            shippingPhone: order.telefoneEntrega,
            shippingReference: order.referenciaEntrega || null,
            deliveryFee: order.taxaEntrega,
            notes: order.observacoes,
            precisaTroco: order.precisaTroco || false,
            valorTroco: order.valorTroco ? Number(order.valorTroco) : null,
            // Campos de pedido de balcão (PDV)
            nomeClienteAvulso: order.nomeClienteAvulso || null,
            identificadorMesaSenha: order.identificadorMesaSenha || null,
            mesaId: order.mesaId ?? null,
            mesaNome: order.mesa?.nome ?? null,
            criadoPorGarcomNome: order.criadoPor?.nomeUsuario || null,
            user: order.usuario ? {
                id: order.usuario.id,
                username: order.usuario.nomeUsuario,
                email: order.usuario.email,
                phone: order.usuario.telefone,
                enderecos: order.usuario.enderecos ? order.usuario.enderecos.map(addr => ({
                    id: addr.id,
                    street: addr.rua,
                    number: addr.numero,
                    complement: addr.complemento,
                    neighborhood: addr.bairro,
                    isDefault: addr.padrao
                })) : []
            } : null,
            orderitem: order.itens_pedido.map(item => {
                // Parsear opcoesSelecionadasSnapshot para garantir que seja sempre um objeto
                const parsedSnapshot = parseOptionsSnapshot(item.opcoesSelecionadasSnapshot);
                
                return {
                    id: item.id,
                    orderId: item.pedidoId,
                    productId: item.produtoId,
                    quantity: item.quantidade,
                    priceAtOrder: item.precoNoPedido,
                    selectedOptionsSnapshot: parsedSnapshot,
                    // Ignorar complementos órfãos (sem registro de complemento vinculado)
                    complements: item.complementos
                        ? item.complementos
                            .filter(comp => comp.complemento)
                            .map(comp => ({
                                id: comp.complemento.id,
                                name: comp.complemento.nome,
                                imageUrl: comp.complemento.imagemUrl
                            }))
                        : [],
                    additionals: item.adicionais ? item.adicionais.map(a => ({
                        id: a.adicional.id,
                        name: a.adicional.nome,
                        value: Number(a.adicional.valor),
                        quantity: a.quantidade || 1,
                        imageUrl: a.adicional.imagemUrl,
                        isActive: a.adicional.ativo
                    })) : [],
                    flavors: item.sabores ? item.sabores.map(s => ({
                        id: s.sabor.id,
                        name: s.sabor.nome,
                        imageUrl: s.sabor.imagemUrl,
                        isActive: s.sabor.ativo
                    })) : [],
                // Tratar itens órfãos (sem produto vinculado) como produto null
                product: item.produto
                    ? {
                        id: item.produto.id,
                        name: item.produto.nome,
                        description: item.produto.descricao,
                        price: item.produto.preco,
                        categoryId: item.produto.categoriaId,
                        isActive: item.produto.ativo,
                        images: item.produto.imagens_produto
                            ? item.produto.imagens_produto.map(img => ({
                                id: img.id,
                                productId: img.produtoId,
                                url: img.url,
                                isPrimary: img.principal
                            }))
                            : []
                    }
                    : null
                };
            }),
            payment: order.pagamento ? {
                id: order.pagamento.id,
                orderId: order.pagamento.pedidoId,
                method: order.pagamento.metodo,
                status: order.pagamento.status,
                amount: order.pagamento.valor,
                paidAt: order.pagamento.pagoEm
            } : null
        }));

        res.json(transformedOrders);
    } catch (err) {
        console.error('Erro ao buscar pedidos:', err);
        res.status(500).json({ error: 'Erro ao buscar pedidos.' });
    }
});

router.get('/pending-count', authenticateToken, authorize('admin'), async (req, res) => {
  const count = await prisma.pedido.count({
    where: {
      lojaId: req.lojaId,
      status: { in: ['pending_payment', 'being_prepared'] }
    }
  });
  res.json({ count });
});

module.exports = router;
