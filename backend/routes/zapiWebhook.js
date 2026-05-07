const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
const {
  sendWhatsAppMessageZApi,
  sendWhatsAppButtonListZApi,
  sendWhatsAppOptionListZApi,
  getWhatsappTemplates,
  interpolateTemplate,
} = require('../services/messageService');
const {
  handleDelivererDeliveredAction,
} = require('./zapiWebhookDelivererActions');
const { getMagicLoginUrlForUsuario } = require('../services/magicLinkService');

const START_ORDER_BUTTON_ID = 'start_order_whatsapp';
const ORDER_SESSION_TTL_MS = 30 * 60 * 1000;
const FALLBACK_LIMIT = 2;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const HANDED_OFF_STEP = 'handed_off_to_human';
const HANDED_OFF_MESSAGE = 'Uma de nossas atendentes vai atendelo.';
const orderSessions = new Map();

function normalizeText(input) {
  return (input || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isGreeting(text) {
  const t = normalizeText(text)
    .replace(/[!?,.;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return false;

  const greetingPatterns = [
    /^oi+\b/,
    /^ola+\b/,
    /^opa+\b/,
    /^epa+\b/,
    /^e\s?ai+\b/,
    /^fala\b/,
    /^salve\b/,
    /^bom dia+\b/,
    /^boa tarde+\b/,
    /^boa noite+\b/,
    /^tudo bem\b/,
    /^tudo bom\b/,
    /^hey+\b/,
    /^hi+\b/,
    /^alo+\b/,
  ];

  return greetingPatterns.some((pattern) => pattern.test(t));
}

function isStartOrderIntent(text) {
  const normalized = normalizeText(text)
    .replace(/[!?,.;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  const intents = new Set([
    START_ORDER_BUTTON_ID,
    'realizar pedido por aqui',
    'fazer pedido por aqui',
    'realizar pedido',
    'fazer pedido',
    'iniciar pedido',
  ]);

  return intents.has(normalized);
}

function getSessionKey(lojaId, phone) {
  return `${lojaId}:${phone}`;
}

function getOrderSession(lojaId, phone) {
  const key = getSessionKey(lojaId, phone);
  const existing = orderSessions.get(key);
  if (!existing) return null;

  if (Date.now() - existing.updatedAt > ORDER_SESSION_TTL_MS) {
    orderSessions.delete(key);
    return null;
  }

  return existing;
}

function setOrderSession(lojaId, phone, data) {
  const key = getSessionKey(lojaId, phone);
  const existing = orderSessions.get(key);
  const next = { ...data };
  if (existing && data && data.step && existing.step !== data.step) {
    next.fallbackCount = 0;
  }
  orderSessions.set(key, {
    ...next,
    updatedAt: Date.now(),
  });
}

function clearOrderSession(lojaId, phone) {
  const key = getSessionKey(lojaId, phone);
  orderSessions.delete(key);
}

function isSessionInactive(session) {
  if (!session) return false;
  return Date.now() - (Number(session.updatedAt) || 0) > INACTIVITY_TIMEOUT_MS;
}

function markSessionHandedOff(lojaId, phone) {
  const key = getSessionKey(lojaId, phone);
  const existing = orderSessions.get(key) || {};
  orderSessions.set(key, {
    ...existing,
    step: HANDED_OFF_STEP,
    fallbackCount: 0,
    updatedAt: Date.now(),
  });
}

async function sendFallbackMessage(lojaId, phone, message) {
  const key = getSessionKey(lojaId, phone);
  const existing = orderSessions.get(key);
  const nextCount = (Number(existing?.fallbackCount) || 0) + 1;

  if (nextCount > FALLBACK_LIMIT) {
    markSessionHandedOff(lojaId, phone);
    try {
      await sendWhatsAppMessageZApi(phone, HANDED_OFF_MESSAGE, lojaId);
    } catch (err) {
      console.error('❌ [Z-API Webhook] Erro ao enviar mensagem de transferencia para atendente:', err);
    }
    console.log(`🛑 [Z-API Webhook] Fluxo encerrado por excesso de fallbacks (>${FALLBACK_LIMIT}). Telefone: ${phone}`);
    return true;
  }

  orderSessions.set(key, {
    ...(existing || {}),
    fallbackCount: nextCount,
    updatedAt: Date.now(),
  });

  await sendWhatsAppMessageZApi(phone, message, lojaId);
  return false;
}

async function fetchStoreCategories(lojaId) {
  const categories = await prisma.categoria_produto.findMany({
    where: { lojaId },
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    select: {
      id: true,
      nome: true,
    },
  });

  return categories || [];
}

async function fetchProductsByCategory(lojaId, categoriaId) {
  return prisma.produto.findMany({
    where: {
      lojaId,
      categoriaId,
      ativo: true,
    },
    orderBy: [{ destaque: 'desc' }, { nome: 'asc' }],
    select: {
      id: true,
      nome: true,
      descricao: true,
      preco: true,
      recebeSabores: true,
      recebeComplementos: true,
      quantidadeComplementos: true,
      recebeAdicionais: true,
      categorias_sabor: {
        select: {
          quantidade: true,
          categoriaSabor: {
            select: {
              nome: true,
              sabores: {
                where: { ativo: true },
                select: {
                  id: true,
                  nome: true,
                },
                orderBy: [{ nome: 'asc' }],
              },
            },
          },
        },
      },
      categorias_adicional: {
        select: {
          quantidade: true,
          categoriaAdicional: {
            select: {
              nome: true,
              adicionais: {
                where: { ativo: true },
                select: {
                  id: true,
                  nome: true,
                },
                orderBy: [{ nome: 'asc' }],
              },
            },
          },
        },
      },
    },
  });
}

async function fetchActiveComplements(lojaId) {
  const items = await prisma.complemento.findMany({
    where: { lojaId, ativo: true },
    select: { id: true, nome: true },
    orderBy: [{ nome: 'asc' }],
  });
  return items || [];
}

function buildCategoriesMenuText(categories) {
  if (!categories.length) {
    return 'No momento nao encontramos categorias disponiveis.';
  }

  return 'Qual categoria de produtos voce gostaria de verificar?\n\nEscolha no menu abaixo:';
}

function parseCategorySelection(text, categories) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= categories.length) {
    return categories[asNumber - 1];
  }

  return categories.find((category, index) => {
    const expectedId = `cat_${category.id}`;
    if (normalized === expectedId) return true;
    if (normalized === normalizeText(category.nome)) return true;
    if (normalized === String(index + 1)) return true;
    return false;
  }) || null;
}

function parseProductSelection(text, products) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= products.length) {
    return products[asNumber - 1];
  }

  return products.find((product, index) => {
    if (normalized === `prod_${product.id}`) return true;
    if (normalized === normalizeText(product.nome)) return true;
    if (normalized === String(index + 1)) return true;
    return false;
  }) || null;
}

function isSkipAnswer(text) {
  const normalized = normalizeIntentText(text);
  return normalized === 'skip_field' || normalized === 'pular' || normalized === 'sem';
}

function normalizeIntentText(text) {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .replace(/[!?,.;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCartAction(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  if (
    normalized === 'cart_add_more' ||
    normalized === 'adicionar' ||
    normalized === 'adicionar mais' ||
    normalized === 'adicionar mais itens' ||
    normalized === '1'
  ) {
    return 'add_more';
  }

  if (
    normalized === 'cart_finalize' ||
    normalized === 'finalizar' ||
    normalized === 'finalizar pedido' ||
    normalized === '2'
  ) {
    return 'finalize';
  }

  if (
    normalized === 'cart_cancel' ||
    normalized === 'cancelar' ||
    normalized === 'cancelar pedido' ||
    normalized === '3'
  ) {
    return 'cancel';
  }

  return null;
}

function parseDeliveryTypeAction(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  if (['delivery_type_delivery', 'entrega', 'delivery', '1'].includes(normalized)) return 'delivery';
  if (['delivery_type_pickup', 'retirada', 'pickup', '2'].includes(normalized)) return 'pickup';
  return null;
}

function parsePaymentMethodAction(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  if (['payment_pix', 'pix', '1'].includes(normalized)) return 'PIX';
  if (['payment_card', 'cartao', 'cartao na entrega', '2'].includes(normalized)) return 'CREDIT_CARD';
  if (['payment_cash', 'dinheiro', '3'].includes(normalized)) return 'CASH_ON_DELIVERY';
  return null;
}

function parsePositiveAnswer(text) {
  const normalized = normalizeIntentText(text);
  const positives = new Set([
    'sim',
    'yes',
    '1',
    'upsell_yes',
    'adicionar',
    'quero',
    'sim adicionar',
    'sim adicionar bebida',
  ]);
  return positives.has(normalized);
}

function parseNegativeAnswer(text) {
  const normalized = normalizeIntentText(text);
  const negatives = new Set([
    'nao',
    '2',
    'upsell_no',
    'continuar',
    'nao continuar',
    'nao continuar pedido',
  ]);
  return negatives.has(normalized);
}

function buildProductsMenuText(categoryName, products) {
  const lines = (products || []).slice(0, 30).map((product, index) => {
    const productName = product?.nome || 'Produto';
    const description = product?.descricao ? ` - ${product.descricao}` : '';
    const price = `R$ ${formatCurrency(product?.preco || 0)}`;
    return `${index + 1} - ${productName}${description} (${price})`;
  });

  return `Voce escolheu *${categoryName}*. Qual item da categoria?\n\n${lines.join('\n')}\n\nEscolha no menu abaixo:`;
}

function buildCartSummary(cart) {
  const lines = cart.map((item) => {
    const details = [];
    if (item.flavors) details.push(`sabores: ${item.flavors}`);
    if (item.complements) details.push(`complementos: ${item.complements}`);
    if (item.additionals) details.push(`adicionais: ${item.additionals}`);
    if (item.observation) details.push(`obs: ${item.observation}`);
    const detailsText = details.length ? ` (${details.join(' | ')})` : '';
    return `${item.quantity}x ${item.name}${detailsText}`;
  });

  const total = cart.reduce((acc, item) => acc + Number(item.price || 0) * Number(item.quantity || 1), 0);
  return `Pedido atual:\n${lines.join('\n')}\n\nTotal parcial: R$ ${formatCurrency(total)}`;
}

function getCartSubtotal(cart) {
  return (cart || []).reduce((acc, item) => acc + Number(item.price || 0) * Number(item.quantity || 1), 0);
}

async function fetchCheckoutConfig(lojaId) {
  const config = await prisma.configuracao_loja.findUnique({
    where: { lojaId },
    select: {
      taxaEntrega: true,
      valorPedidoMinimo: true,
      pagamentoPixAtivo: true,
      pagamentoCartaoEntregaAtivo: true,
      pagamentoCartaoRetiradaAtivo: true,
      pagamentoDinheiroEntregaAtivo: true,
      pagamentoDinheiroRetiradaAtivo: true,
    },
  });
  return config || null;
}

async function fetchDeliveryScheduleConfig(lojaId) {
  const config = await prisma.configuracao_loja.findUnique({
    where: { lojaId },
    select: {
      deliveryAtivo: true,
      horarioDeliveryPorDia: true,
      horaEntregaInicio: true,
      horaEntregaFim: true,
    },
  });
  return config || null;
}

function isDeliveryOpenNow(config) {
  if (!config) return { open: true };
  if ((config.deliveryAtivo ?? true) === false) {
    return { open: false, reason: 'delivery_disabled' };
  }

  const now = getNowInSaoPaulo();
  const day = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const scheduleByDay = config.horarioDeliveryPorDia;

  if (scheduleByDay && typeof scheduleByDay === 'object') {
    const dayCfg = scheduleByDay[String(day)];
    if (dayCfg && typeof dayCfg === 'object') {
      if (dayCfg.aberto === false) {
        return { open: false, reason: 'delivery_closed_by_day' };
      }
      const openMinutes = timeToMinutes(dayCfg.abertura || config.horaEntregaInicio);
      const closeMinutes = timeToMinutes(dayCfg.fechamento || config.horaEntregaFim);
      if (openMinutes != null && closeMinutes != null && !isWithinWindow(nowMinutes, openMinutes, closeMinutes)) {
        return { open: false, reason: 'delivery_closed_by_time' };
      }
      return { open: true };
    }
  }

  const openMinutes = timeToMinutes(config.horaEntregaInicio);
  const closeMinutes = timeToMinutes(config.horaEntregaFim);
  if (openMinutes != null && closeMinutes != null && !isWithinWindow(nowMinutes, openMinutes, closeMinutes)) {
    return { open: false, reason: 'delivery_closed_by_time' };
  }
  return { open: true };
}

async function fetchDeliveryNeighborhoods(lojaId) {
  const items = await prisma.bairro_entrega.findMany({
    where: { lojaId },
    orderBy: [{ nome: 'asc' }],
    select: { id: true, nome: true, nomeNormalizado: true, taxaEntrega: true },
  });
  return items || [];
}

function parseNeighborhoodSelection(text, neighborhoods) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= neighborhoods.length) {
    return neighborhoods[asNumber - 1];
  }
  return neighborhoods.find((n) =>
    normalized === `neighborhood_${n.id}` ||
    normalized === normalizeIntentText(n.nome) ||
    normalized === normalizeIntentText(n.nomeNormalizado || '')
  ) || null;
}

function parseSavedAddressSelection(text, addresses) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  if (normalized === 'new_address' || normalized === 'outro' || normalized === 'novo' || normalized === '0') {
    return { type: 'new' };
  }
  if (normalized.startsWith('addr_')) {
    const selectedId = Number(normalized.replace('addr_', ''));
    if (Number.isFinite(selectedId)) {
      const foundById = (addresses || []).find((addr) => Number(addr.id) === selectedId);
      if (foundById) return { type: 'saved', address: foundById };
    }
  }
  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= addresses.length) {
    return { type: 'saved', address: addresses[asNumber - 1] };
  }
  const leadingNumberMatch = normalized.match(/^(\d+)\b/);
  if (leadingNumberMatch) {
    const index = Number(leadingNumberMatch[1]);
    if (Number.isFinite(index) && index >= 1 && index <= addresses.length) {
      return { type: 'saved', address: addresses[index - 1] };
    }
  }
  const matchedByText = (addresses || []).find((addr) => {
    const street = normalizeIntentText(addr.street || '');
    const number = normalizeIntentText(addr.number || '');
    const neighborhood = normalizeIntentText(addr.neighborhood || '');
    const complement = normalizeIntentText(addr.complement || '');
    const reference = normalizeIntentText(addr.reference || '');
    const combinedStreet = normalizeIntentText(`${addr.street || ''} ${addr.number || ''}`);
    const combinedNeighborhood = normalizeIntentText(
      `${addr.neighborhood || ''}${addr.complement ? ` - ${addr.complement}` : ''}`
    );
    return (
      normalized === street ||
      normalized === combinedStreet ||
      normalized === neighborhood ||
      normalized === combinedNeighborhood ||
      (complement && normalized === complement) ||
      (reference && normalized === reference)
    );
  });
  if (matchedByText) {
    return { type: 'saved', address: matchedByText };
  }
  return null;
}

function normalizePhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 11 && digits.startsWith('55')) return digits.slice(2);
  return digits;
}

async function resolveCustomerByPhone(lojaId, phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  const tail = digits.slice(-8);
  const candidates = [...new Set([digits, `55${digits}`, tail])];

  const customer = await prisma.usuario.findFirst({
    where: {
      lojaId,
      OR: candidates.map((value) => ({ telefone: { contains: value } })),
    },
    select: {
      id: true,
      nomeUsuario: true,
      telefone: true,
      funcao: true,
      enderecos: {
        select: {
          id: true,
          rua: true,
          numero: true,
          complemento: true,
          bairro: true,
          pontoReferencia: true,
          padrao: true,
        },
        orderBy: [{ padrao: 'desc' }, { id: 'asc' }],
      },
    },
  });

  if (!customer) return null;
  return {
    id: customer.id,
    name: String(customer.nomeUsuario || '').trim(),
    phone: String(customer.telefone || '').trim(),
    funcao: customer.funcao,
    addresses: (customer.enderecos || []).map((addr) => ({
      id: addr.id,
      street: addr.rua,
      number: addr.numero,
      complement: addr.complemento || '',
      neighborhood: addr.bairro,
      reference: addr.pontoReferencia || '',
      isDefault: Boolean(addr.padrao),
    })),
  };
}

async function sendDeliveryTypePrompt(phone, lojaId) {
  const message = 'Como deseja receber seu pedido?';
  const result = await sendWhatsAppButtonListZApi(
    phone,
    message,
    [
      { id: 'delivery_type_delivery', label: '🚚 Entrega' },
      { id: 'delivery_type_pickup', label: '🏪 Retirada' },
    ],
    lojaId
  );
  if (!result.success) {
    await sendWhatsAppMessageZApi(phone, `${message}\n\n1 - Entrega\n2 - Retirada`, lojaId);
  }
}

function getAllowedPaymentButtons(cfg, deliveryType) {
  const pix = cfg?.pagamentoPixAtivo ?? true;
  const card = deliveryType === 'delivery'
    ? (cfg?.pagamentoCartaoEntregaAtivo ?? true)
    : (cfg?.pagamentoCartaoRetiradaAtivo ?? true);
  const cash = deliveryType === 'delivery'
    ? (cfg?.pagamentoDinheiroEntregaAtivo ?? true)
    : (cfg?.pagamentoDinheiroRetiradaAtivo ?? true);

  const buttons = [];
  if (pix) buttons.push({ id: 'payment_pix', label: 'Pix' });
  if (card) buttons.push({ id: 'payment_card', label: 'Cartao na entrega' });
  if (cash) buttons.push({ id: 'payment_cash', label: 'Dinheiro' });
  return buttons;
}

async function sendPaymentMethodPrompt(phone, lojaId, cfg, deliveryType) {
  const buttons = getAllowedPaymentButtons(cfg, deliveryType);
  if (!buttons.length) {
    await sendWhatsAppMessageZApi(phone, 'Nenhum metodo de pagamento esta disponivel no momento.', lojaId);
    return false;
  }
  const result = await sendWhatsAppButtonListZApi(phone, 'Escolha a forma de pagamento:', buttons, lojaId);
  if (!result.success) {
    const fallback = buttons.map((b, i) => `${i + 1} - ${b.label}`).join('\n');
    await sendWhatsAppMessageZApi(phone, `Escolha a forma de pagamento:\n${fallback}`, lojaId);
  }
  return true;
}

function getBeverageCategories(categories) {
  return categories.filter((category) => {
    const normalizedName = normalizeText(category.nome);
    return normalizedName.includes('bebida') || normalizedName.includes('refrigerante') || normalizedName.includes('suco');
  });
}

function buildSessionWithTimestamp(session) {
  return {
    ...session,
    updatedAt: Date.now(),
  };
}

async function sendCartActionPrompt(phone, lojaId, summaryText) {
  const buttons = [
    { id: 'cart_add_more', label: '➕ Adicionar mais itens' },
    { id: 'cart_finalize', label: '✅ Finalizar pedido' },
    { id: 'cart_cancel', label: '❌ Cancelar' },
  ];

  const result = await sendWhatsAppButtonListZApi(phone, summaryText, buttons, lojaId);
  if (!result.success) {
    await sendWhatsAppMessageZApi(
      phone,
      `${summaryText}\n\nResponda: adicionar | finalizar | cancelar`,
      lojaId
    );
  }
}

async function sendCategoriesPrompt(phone, lojaId, categories) {
  const categoriesMenu = buildCategoriesMenuText(categories);
  const options = (categories || []).slice(0, 30).map((category) => ({
    id: `cat_${category.id}`,
    title: category.nome,
    // Alguns payloads da Z-API retornam a description como texto selecionado.
    // Mantemos o nome da categoria também aqui para garantir parsing correto.
    description: category.nome,
  }));

  if (options.length > 0) {
    const optionResult = await sendWhatsAppOptionListZApi(
      phone,
      categoriesMenu,
      options,
      lojaId,
      {
        title: 'Categorias disponíveis',
        buttonLabel: 'Escolher categoria',
      }
    );
    if (optionResult.success) return;
  }

  await sendWhatsAppMessageZApi(phone, categoriesMenu, lojaId);
}

async function sendProductsPrompt(phone, lojaId, categoryName, products) {
  const productsMessage = buildProductsMenuText(categoryName, products);
  const options = (products || []).slice(0, 30).map((product) => ({
    id: `prod_${product.id}`,
    title: product.nome,
    // Alguns payloads retornam a description como texto selecionado.
    description: product.nome,
  }));

  if (options.length > 0) {
    const optionResult = await sendWhatsAppOptionListZApi(
      phone,
      productsMessage,
      options,
      lojaId,
      {
        title: `Itens de ${categoryName}`,
        buttonLabel: 'Escolher item',
      }
    );
    if (optionResult.success) return;
  }

  await sendWhatsAppMessageZApi(phone, productsMessage, lojaId);
}

async function sendNeighborhoodsPrompt(phone, lojaId, neighborhoods) {
  const message = 'Escolha o bairro de entrega (bairros cadastrados):\n\nEscolha no menu abaixo:';
  const options = (neighborhoods || []).slice(0, 30).map((n) => ({
    id: `neighborhood_${n.id}`,
    title: n.nome,
    // Alguns payloads retornam a description como texto selecionado.
    description: n.nome,
  }));

  if (options.length > 0) {
    const optionResult = await sendWhatsAppOptionListZApi(
      phone,
      message,
      options,
      lojaId,
      {
        title: 'Bairros de entrega',
        buttonLabel: 'Escolher bairro',
      }
    );
    if (optionResult.success) return;
  }

  const fallbackList = (neighborhoods || []).map((n, i) => `${i + 1} - ${n.nome}`).join('\n');
  await sendWhatsAppMessageZApi(
    phone,
    `Escolha o bairro de entrega (bairros cadastrados):\n\n${fallbackList}\n\nResponda com o numero ou nome do bairro.`,
    lojaId
  );
}

async function sendSavedAddressesPrompt(phone, lojaId, customerName, addresses) {
  const lines = (addresses || []).map((addr, index) => {
    const complement = addr.complement ? ` - ${addr.complement}` : '';
    const reference = addr.reference ? ` (Ref: ${addr.reference})` : '';
    const defaultMark = addr.isDefault ? ' [Padrao]' : '';
    return `${index + 1} - ${addr.street}, ${addr.number}${complement} - ${addr.neighborhood}${reference}${defaultMark}`;
  });
  const message = `Encontramos enderecos cadastrados para ${customerName || 'voce'}.\n\nEscolha no menu abaixo:`;
  const options = (addresses || []).slice(0, 29).map((addr, index) => {
    const complement = addr.complement ? ` - ${addr.complement}` : '';
    const defaultMark = addr.isDefault ? ' [Padrao]' : '';
    return {
      id: `addr_${addr.id}`,
      title: `${index + 1} - ${addr.street}, ${addr.number}${defaultMark}`,
      description: `${index + 1} - ${addr.neighborhood}${complement}`,
    };
  });
  options.push({
    id: 'new_address',
    title: '0 - Usar outro endereco',
    description: 'Informar novo endereco manualmente',
  });

  const optionResult = await sendWhatsAppOptionListZApi(
    phone,
    message,
    options,
    lojaId,
    {
      title: 'Enderecos cadastrados',
      buttonLabel: 'Escolher endereco',
    }
  );
  if (optionResult.success) return;

  const fallbackMessage =
    `Encontramos enderecos cadastrados para ${customerName || 'voce'}:\n\n` +
    `${lines.join('\n')}\n\n` +
    'Responda com o numero do endereco desejado.\n' +
    'Ou responda *0* para informar outro endereco.';
  await sendWhatsAppMessageZApi(phone, fallbackMessage, lojaId);
}

async function proceedToPaymentAfterDeliveryAddress(lojaId, phone, session) {
  const cfg = await fetchCheckoutConfig(lojaId);
  const subtotal = getCartSubtotal(session.cart || []);
  const deliveryFee = Number(session.deliveryFee || 0);
  const total = subtotal + deliveryFee;
  const minOrder = cfg?.valorPedidoMinimo != null ? Number(cfg.valorPedidoMinimo) : null;
  if (minOrder != null && total < minOrder) {
    await sendWhatsAppMessageZApi(
      phone,
      `Pedido abaixo do valor minimo para entrega.\nSubtotal: R$ ${formatCurrency(subtotal)}\nTaxa: R$ ${formatCurrency(deliveryFee)}\nTotal: R$ ${formatCurrency(total)}\nMinimo: R$ ${formatCurrency(minOrder)}\n\nAdicione mais itens para continuar.`,
      lojaId
    );
    setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...session, step: 'awaiting_cart_action' }));
    await sendCartActionPrompt(phone, lojaId, buildCartSummary(session.cart || []));
    return;
  }

  setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...session, step: 'awaiting_payment_method' }));
  await sendWhatsAppMessageZApi(
    phone,
    `Endereco validado.\nTaxa de entrega: R$ ${formatCurrency(deliveryFee)}\nTotal com entrega: R$ ${formatCurrency(total)}`,
    lojaId
  );
  await sendPaymentMethodPrompt(phone, lojaId, cfg, 'delivery');
}

function buildFlavorPrompt(pendingItem) {
  const groups = Array.isArray(pendingItem?.flavorGroups) ? pendingItem.flavorGroups : [];
  const maxFlavors = Number(pendingItem?.maxFlavors || 0);

  if (!groups.length) {
    return `Voce escolheu *${pendingItem?.name || 'item'}*.\nInforme os *sabores* desse item (obrigatorio).`;
  }

  const lines = [];
  groups.forEach((group) => {
    const sabores = Array.isArray(group?.flavors)
      ? group.flavors
          .map((flavor) => (typeof flavor === 'string' ? flavor : flavor?.nome || ''))
          .filter(Boolean)
      : [];
    if (!sabores.length) return;
    lines.push(`- ${group.categoryName}: ${sabores.join(', ')}`);
  });

  const limitText = maxFlavors > 0
    ? `Quantidade maxima de sabores para este produto: *${maxFlavors}*.\n`
    : '';

  return (
    `Voce escolheu *${pendingItem?.name || 'item'}*.\n` +
    `${limitText}` +
    'Sabores disponiveis:\n' +
    `${lines.join('\n')}\n\n` +
    'Digite os sabores separados por virgula.'
  );
}

function buildComplementsPrompt(pendingItem) {
  const options = Array.isArray(pendingItem?.complementOptions) ? pendingItem.complementOptions : [];
  const maxComplements = Number(pendingItem?.maxComplements || 0);
  const limitText = maxComplements > 0
    ? `Quantidade maxima de complementos para este produto: *${maxComplements}*.\n`
    : '';

  if (!options.length) {
    return `Informe os *complementos* (opcional).\n${limitText}Se quiser pular, use o botao Pular.`;
  }

  return (
    `${limitText}` +
    `Complementos disponiveis:\n- ${options.join('\n- ')}\n\n` +
    'Digite os complementos separados por virgula (ou clique em Pular).'
  );
}

function buildAdditionalsPrompt(pendingItem) {
  const groups = Array.isArray(pendingItem?.additionalGroups) ? pendingItem.additionalGroups : [];
  const maxAdditionals = Number(pendingItem?.maxAdditionals || 0);
  const limitText = maxAdditionals > 0
    ? `Quantidade maxima de adicionais para este produto: *${maxAdditionals}*.\n`
    : '';

  if (!groups.length) {
    return `Informe os *adicionais* (opcional).\n${limitText}Se quiser pular, use o botao Pular.`;
  }

  const lines = [];
  groups.forEach((group) => {
    const names = Array.isArray(group?.additionals) ? group.additionals : [];
    if (!names.length) return;
    lines.push(`- ${group.categoryName}: ${names.join(', ')}`);
  });

  return (
    `${limitText}` +
    'Adicionais disponiveis:\n' +
    `${lines.join('\n')}\n\n` +
    'Digite os adicionais separados por virgula (ou clique em Pular).'
  );
}

function countFlavorEntries(input) {
  if (!input || typeof input !== 'string') return 0;
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function splitCsvValues(input) {
  if (!input || typeof input !== 'string') return [];
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function splitSelectionValues(input) {
  if (!input || typeof input !== 'string') return [];
  return input
    .split(/,|;|\/|\||\s+e\s+/i)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveIdsByNames(rawInput, entries) {
  const tokens = splitSelectionValues(rawInput);
  if (!tokens.length || !Array.isArray(entries) || !entries.length) return [];

  const resolved = [];
  tokens.forEach((token) => {
    const normalizedToken = normalizeIntentText(token);
    if (!normalizedToken) return;

    const exact = entries.find((entry) => entry.normalizedName === normalizedToken);
    if (exact) {
      resolved.push(exact.id);
      return;
    }

    const partial = entries.find(
      (entry) =>
        entry.normalizedName.includes(normalizedToken) ||
        normalizedToken.includes(entry.normalizedName)
    );
    if (partial) {
      resolved.push(partial.id);
    }
  });

  return [...new Set(resolved)];
}

function resolveFlavorIdsFromPendingItem(rawInput, pendingItem) {
  const groups = Array.isArray(pendingItem?.flavorGroups) ? pendingItem.flavorGroups : [];
  const entries = [];
  groups.forEach((group) => {
    const flavors = Array.isArray(group?.flavors) ? group.flavors : [];
    flavors.forEach((flavor) => {
      if (flavor && typeof flavor === 'object' && flavor.id != null) {
        entries.push({
          id: Number(flavor.id),
          normalizedName: normalizeIntentText(flavor.nome || ''),
        });
      }
    });
  });
  return resolveIdsByNames(rawInput, entries);
}

function parseAdditionalEntries(input) {
  const values = splitCsvValues(input);
  return values.map((entry) => {
    const match = entry.match(/^(\d+)\s*x?\s*(.+)$/i);
    if (!match) {
      return { name: entry, quantity: 1 };
    }
    const quantity = Number(match[1]);
    return {
      name: (match[2] || '').trim(),
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    };
  }).filter((entry) => entry.name);
}

async function goToNextCustomizationStep(lojaId, phone, session, justHandledStep) {
  const pendingItem = { ...(session.pendingItem || {}) };
  if (!pendingItem || !pendingItem.productId) {
    await sendFallbackMessage(lojaId, phone, 'Nao foi possivel continuar a personalizacao. Escolha um item novamente.');
    return 'error';
  }

  if (justHandledStep === 'flavors') {
    if (pendingItem.acceptsComplements) {
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...session, step: 'awaiting_complements', pendingItem })
      );
      const msg = buildComplementsPrompt(pendingItem);
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return 'ok';
    }

    if (pendingItem.acceptsAdditionals) {
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...session, step: 'awaiting_additionals', pendingItem })
      );
      const msg = buildAdditionalsPrompt(pendingItem);
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return 'ok';
    }

    setOrderSession(
      lojaId,
      phone,
      buildSessionWithTimestamp({ ...session, step: 'awaiting_observation', pendingItem })
    );
    const msg = 'Alguma observacao para esse item? (opcional)';
    const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
    if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
    return 'ok';
  }

  if (justHandledStep === 'complements') {
    if (pendingItem.acceptsAdditionals) {
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...session, step: 'awaiting_additionals', pendingItem })
      );
      const msg = buildAdditionalsPrompt(pendingItem);
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return 'ok';
    }

    setOrderSession(
      lojaId,
      phone,
      buildSessionWithTimestamp({ ...session, step: 'awaiting_observation', pendingItem })
    );
    const msg = 'Alguma observacao para esse item? (opcional)';
    const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
    if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
    return 'ok';
  }

  if (justHandledStep === 'additionals') {
    setOrderSession(
      lojaId,
      phone,
      buildSessionWithTimestamp({ ...session, step: 'awaiting_observation', pendingItem })
    );
    const msg = 'Alguma observacao para esse item? (opcional)';
    const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
    if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
    return 'ok';
  }

  return 'ok';
}

function formatCurrency(value) {
  const asNumber = Number(value || 0);
  return asNumber.toFixed(2).replace('.', ',');
}

function normalizePhoneForOrder(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 11 && digits.startsWith('55')) return digits.slice(2);
  return digits;
}

function buildWhatsappItemsTextFromCart(cart) {
  return (cart || [])
    .map((item) => {
      const quantity = Number(item.quantity || 1);
      const name = item.name || 'Produto';
      const lines = [`• ${quantity}x ${name}`];

      const flavors = String(item.flavors || '').trim();
      const complements = String(item.complements || '').trim();
      const additionals = String(item.additionals || '').trim();
      const observation = String(item.observation || '').trim();

      if (flavors) lines.push(`  Sabores: ${flavors}`);
      if (complements) lines.push(`  Complementos: ${complements}`);
      if (additionals) lines.push(`  Adicionais: ${additionals}`);
      if (observation) lines.push(`  Obs: ${observation}`);

      return lines.join('\n');
    })
    .join('\n');
}

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

async function sendWhatsAppButtonOtpZApi(phone, message, code, lojaId, buttonText) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
  const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-button-otp`;

  const body = {
    phone: `55${cleanPhone}`,
    message,
    code: String(code ?? ''),
  };

  if (buttonText) {
    body.buttonText = buttonText;
  }

  return axios.post(zapApiUrl, body, {
    headers: {
      'client-token': zapApiClientToken,
      'Content-Type': 'application/json',
    },
  });
}

async function getOrCreateBalcaoUserId(lojaId) {
  let user = await prisma.usuario.findFirst({
    where: {
      lojaId,
      nomeUsuario: 'USUARIO_BALCAO',
    },
    select: { id: true },
  });
  if (user?.id) return user.id;

  const generatedPassword = `balcao_${lojaId}_${Date.now()}`;
  const hashedPassword = await bcrypt.hash(generatedPassword, 10);
  user = await prisma.usuario.create({
    data: {
      lojaId,
      nomeUsuario: 'USUARIO_BALCAO',
      senha: hashedPassword,
      funcao: 'user',
      email: `balcao_${lojaId}@sistema.local`,
      telefone: `9999999999${String(lojaId).padStart(3, '0')}`,
    },
    select: { id: true },
  });

  return user.id;
}

async function createCounterOrderFromWhatsApp(lojaId, phone, session) {
  const cart = Array.isArray(session?.cart) ? session.cart : [];
  if (!cart.length) {
    throw new Error('Carrinho vazio para criar pedido.');
  }

  const balcaoUserId = await getOrCreateBalcaoUserId(lojaId);

  const flavorNamesSet = new Set();
  const complementNamesSet = new Set();
  const additionalNamesSet = new Set();

  cart.forEach((item) => {
    splitCsvValues(item.flavors).forEach((name) => flavorNamesSet.add(normalizeIntentText(name)));
    splitCsvValues(item.complements).forEach((name) => complementNamesSet.add(normalizeIntentText(name)));
    parseAdditionalEntries(item.additionals).forEach((entry) => additionalNamesSet.add(normalizeIntentText(entry.name)));
  });

  const [flavorsDb, complementsDb, additionalsDb] = await Promise.all([
    flavorNamesSet.size > 0
      ? prisma.sabor.findMany({
          where: { lojaId, ativo: true },
          select: { id: true, nome: true },
        })
      : Promise.resolve([]),
    complementNamesSet.size > 0
      ? prisma.complemento.findMany({
          where: { lojaId, ativo: true },
          select: { id: true, nome: true },
        })
      : Promise.resolve([]),
    additionalNamesSet.size > 0
      ? prisma.adicional.findMany({
          where: { lojaId, ativo: true },
          select: { id: true, nome: true },
        })
      : Promise.resolve([]),
  ]);

  const flavorEntries = (flavorsDb || []).map((item) => ({
    id: item.id,
    normalizedName: normalizeIntentText(item.nome),
  }));
  const complementEntries = (complementsDb || []).map((item) => ({
    id: item.id,
    normalizedName: normalizeIntentText(item.nome),
  }));
  const additionalEntries = (additionalsDb || []).map((item) => ({
    id: item.id,
    normalizedName: normalizeIntentText(item.nome),
    value: Number(item.valor || 0),
  }));
  const additionalValueById = new Map(additionalEntries.map((entry) => [entry.id, Number(entry.value || 0)]));

  const preparedItems = cart.map((item) => {
    const basePrice = Number(item.price || 0);
    const quantity = Number(item.quantity || 1);

    const flavorIdsFromFlow = Array.isArray(item.flavorIds)
      ? item.flavorIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const flavorCreates = (flavorIdsFromFlow.length
      ? [...new Set(flavorIdsFromFlow)]
      : resolveIdsByNames(item.flavors, flavorEntries))
      .map((saborId) => ({ saborId, quantidade: 1 }));
    const complementCreates = resolveIdsByNames(item.complements, complementEntries)
      .map((complementoId) => ({ complementoId }));
    const additionalCreates = parseAdditionalEntries(item.additionals)
      .map((entry) => ({
        adicionalId: resolveIdsByNames(entry.name, additionalEntries)[0],
        quantidade: Number(entry.quantity || 1),
      }))
      .filter((entry) => Boolean(entry.adicionalId));

    const additionalTotalPerUnit = additionalCreates.reduce((sum, additional) => {
      const additionalValue = Number(additionalValueById.get(additional.adicionalId) || 0);
      return sum + (additionalValue * Number(additional.quantidade || 1));
    }, 0);
    const unitPrice = basePrice + additionalTotalPerUnit;
    return {
      productId: item.productId,
      quantity,
      unitPrice,
      flavors: item.flavors || '',
      complements: item.complements || '',
      additionals: item.additionals || '',
      observation: item.observation || '',
      flavorCreates,
      complementCreates,
      additionalCreates,
    };
  });

  const subtotal = preparedItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
  const deliveryFee = Number(session?.deliveryType === 'delivery' ? (session.deliveryFee || 0) : 0);
  const total = subtotal + deliveryFee;
  const paymentMethod = session?.paymentMethod;
  const initialStatus = paymentMethod === 'PIX' ? 'pending_payment' : 'being_prepared';

  const pedido = await prisma.pedido.create({
    data: {
      lojaId,
      usuarioId: balcaoUserId,
      status: initialStatus,
      inicioPreparoEm: initialStatus === 'being_prepared' ? new Date() : null,
      precoTotal: total,
      taxaEntrega: deliveryFee,
      tipoEntrega: session?.deliveryType === 'delivery' ? 'delivery' : 'pickup',
      metodoPagamento: paymentMethod,
      observacoes: session?.orderObservation || null,
      precisaTroco: Boolean(session?.cashChangeValue),
      valorTroco: session?.cashChangeValue ? Number(session.cashChangeValue) : null,
      nomeClienteAvulso: session?.customerName || null,
      ruaEntrega: session?.deliveryType === 'delivery' ? session?.deliveryAddress?.street || null : null,
      numeroEntrega: session?.deliveryType === 'delivery' ? session?.deliveryAddress?.number || null : null,
      bairroEntrega: session?.deliveryType === 'delivery' ? session?.deliveryAddress?.neighborhood || null : null,
      complementoEntrega: session?.deliveryType === 'delivery' ? session?.deliveryAddress?.complement || null : null,
      referenciaEntrega: session?.deliveryType === 'delivery' ? session?.deliveryAddress?.reference || null : null,
      telefoneEntrega: normalizePhoneForOrder(phone) || null,
      pagamento: {
        create: {
          valor: total,
          metodo: paymentMethod,
          status: paymentMethod === 'PIX' ? 'PENDING' : 'PAID',
          idTransacao: null,
        },
      },
      itens_pedido: {
        create: preparedItems.map((item) => {
          return {
            produtoId: item.productId,
            quantidade: item.quantity,
            precoNoPedido: item.unitPrice,
            opcoesSelecionadasSnapshot: {
              sabores: item.flavors,
              complementos: item.complements,
              adicionais: item.additionals,
              observacao: item.observation,
            },
            sabores: item.flavorCreates.length ? { create: item.flavorCreates } : undefined,
            complementos: item.complementCreates.length ? { create: item.complementCreates } : undefined,
            adicionais: item.additionalCreates.length ? { create: item.additionalCreates } : undefined,
          };
        }),
      },
    },
    select: {
      id: true,
      criadoEm: true,
      precoTotal: true,
      tipoEntrega: true,
      metodoPagamento: true,
      status: true,
      observacoes: true,
      valorTroco: true,
      precisaTroco: true,
      ruaEntrega: true,
      numeroEntrega: true,
      bairroEntrega: true,
      complementoEntrega: true,
      referenciaEntrega: true,
    },
  });

  return pedido;
}

async function getDailyNumber(orderId, lojaId, criadoEm) {
  try {
    const date = new Date(criadoEm);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
    const dayEnd = new Date(`${yyyy}-${mm}-${dd}T23:59:59-03:00`);
    return await prisma.pedido.count({
      where: {
        lojaId,
        criadoEm: { gte: dayStart, lte: dayEnd },
        id: { lte: orderId },
      },
    });
  } catch {
    return null;
  }
}

async function sendOrderCreatedMessageLikePedidos(lojaId, phone, createdOrder, session) {
  const waTemplates = await getWhatsappTemplates(lojaId);
  const storeConfig = await prisma.configuracao_loja.findUnique({ where: { lojaId } });
  const storePixKey = storeConfig?.chavePix || storeConfig?.telefoneWhatsapp || null;
  const dailyNumber = await getDailyNumber(createdOrder.id, lojaId, createdOrder.criadoEm);
  const dailyNumberStr = String(dailyNumber || createdOrder.id);
  const totalPriceStr = Number(createdOrder.precoTotal || 0).toFixed(2);
  const itensText = buildWhatsappItemsTextFromCart(session.cart || []);
  const notesSection = createdOrder.observacoes && String(createdOrder.observacoes).trim()
    ? `\n\n📝 *Observações:*\n${String(createdOrder.observacoes).trim()}`
    : '';
  const deliveryInfo = createdOrder.tipoEntrega === 'pickup'
    ? '📍 *Retirada no local*'
    : `*Entrega em casa*\n📍 Endereço: ${createdOrder?.ruaEntrega || '-'}, ${createdOrder?.numeroEntrega || '-'}${createdOrder?.complementoEntrega ? ` - ${createdOrder.complementoEntrega}` : ''}\nBairro: ${createdOrder?.bairroEntrega || '-'}${createdOrder?.referenciaEntrega ? `\n*Referência:* ${createdOrder.referenciaEntrega}` : ''}`;

  let message;
  if (createdOrder.metodoPagamento === 'CREDIT_CARD') {
    const prepFooterLine = createdOrder.tipoEntrega === 'pickup'
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
  } else if (createdOrder.metodoPagamento === 'CASH_ON_DELIVERY') {
    const trocoLine = createdOrder.precisaTroco && createdOrder.valorTroco
      ? `\n💰 *Troco para:* R$ ${Number(createdOrder.valorTroco).toFixed(2)}`
      : '';
    const cashPaymentLabel = `Dinheiro ${createdOrder.tipoEntrega === 'pickup' ? 'na Retirada' : 'na Entrega'}`;
    const cashChangeFooterLine = createdOrder.tipoEntrega === 'pickup'
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

  if (createdOrder.metodoPagamento === 'PIX' && storePixKey) {
    try {
      await sendWhatsAppButtonOtpZApi(
        phone,
        message,
        storePixKey,
        lojaId,
        'Copiar chave Pix'
      );
      return;
    } catch {
      const fallbackMessage = message + interpolateTemplate(waTemplates.orderCreatedPixFallbackAppend, { storePixKey });
      await sendWhatsAppMessageZApi(phone, fallbackMessage, lojaId);
      return;
    }
  }

  await sendWhatsAppMessageZApi(phone, message, lojaId);
}

async function finalizeWhatsappOrder(lojaId, phone, session) {
  try {
    const createdOrder = await createCounterOrderFromWhatsApp(lojaId, phone, session);
    await sendOrderCreatedMessageLikePedidos(lojaId, phone, createdOrder, session);
  } catch (createErr) {
    console.error('❌ [Z-API Webhook] Erro ao criar pedido de balcao via WhatsApp:', createErr);
    await sendWhatsAppMessageZApi(
      phone,
      'Nao foi possivel finalizar seu pedido agora. Tente novamente em instantes.',
      lojaId
    );
    return false;
  }

  await sendWhatsAppMessageZApi(
    phone,
    'Acompanhe por aqui: vamos enviar as atualizacoes de status neste numero.',
    lojaId
  );
  clearOrderSession(lojaId, phone);
  return true;
}

function isOrderFlowEnabled(config) {
  const enabled = config?.mensagensWhatsapp?.zapiOrderFlowEnabled;
  if (typeof enabled === 'boolean') return enabled;
  return true;
}

function extractIncomingText(body) {
  if (!body || typeof body !== 'object') return '';

  function isLikelyTechnicalId(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Ex.: 3A00006FE79C265B270D (messageId/correlation ids do provedor)
    if (/^[A-F0-9]{16,}$/i.test(trimmed)) return true;
    // IDs com muitos separadores sem texto humano
    if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed) && !/\s/.test(trimmed)) return true;
    return false;
  }

  // Tentar múltiplos formatos de payload da Z-API
  const candidates = [
    // Respostas de botões/listas (prioridade alta)
    body?.buttonReply?.id,
    body?.buttonReply?.title,
    body?.data?.buttonReply?.id,
    body?.data?.buttonReply?.title,
    body?.data?.message?.buttonsResponseMessage?.selectedButtonId,
    body?.data?.message?.buttonsResponseMessage?.selectedDisplayText,
    body?.message?.buttonsResponseMessage?.selectedButtonId,
    body?.message?.buttonsResponseMessage?.selectedDisplayText,
    body?.messages?.[0]?.buttonsResponseMessage?.selectedButtonId,
    body?.messages?.[0]?.buttonsResponseMessage?.selectedDisplayText,
    body?.data?.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    body?.data?.message?.listResponseMessage?.singleSelectReply?.title,
    body?.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    body?.message?.listResponseMessage?.singleSelectReply?.title,
    body?.messages?.[0]?.listResponseMessage?.singleSelectReply?.selectedRowId,
    body?.messages?.[0]?.listResponseMessage?.singleSelectReply?.title,
    // Formato Z-API específico (text.message, text.body, text.content)
    body?.text?.message,
    body?.text?.body,
    body?.text?.content,
    body?.text?.text,
    // Campos diretos (verificar se são strings, não objetos)
    typeof body.text === 'string' ? body.text : null,
    typeof body.message === 'string' ? body.message : null,
    typeof body.body === 'string' ? body.body : null,
    typeof body.content === 'string' ? body.content : null,
    body.messageText,
    body.textMessage,
    body.messageContent,
    // Data direto
    body?.data?.text,
    body?.data?.body,
    body?.data?.content,
    body?.data?.messageText,
    // Message object
    body?.message?.text,
    body?.message?.body,
    body?.message?.content,
    body?.message?.messageText,
    // Messages array
    body?.messages?.[0]?.text,
    body?.messages?.[0]?.message,
    body?.messages?.[0]?.body,
    body?.messages?.[0]?.content,
    body?.messages?.[0]?.messageText,
    // Conversation
    body?.conversation?.message?.text,
    body?.conversation?.message?.body,
    body?.conversation?.message?.content,
    body?.conversation?.message?.messageText,
    // Formato Z-API comum - data.message
    body?.data?.message?.text,
    body?.data?.message?.body,
    body?.data?.message?.content,
    body?.data?.message?.messageText,
    // Formato Z-API - extendedTextMessage (mensagens longas)
    body?.data?.message?.extendedTextMessage?.text,
    body?.data?.message?.extendedTextMessage?.content,
    body?.message?.extendedTextMessage?.text,
    body?.message?.extendedTextMessage?.content,
    body?.messages?.[0]?.extendedTextMessage?.text,
    body?.messages?.[0]?.extendedTextMessage?.content,
    // Formato Z-API - conversation (mensagens de texto simples)
    body?.data?.message?.conversation,
    body?.message?.conversation,
    body?.messages?.[0]?.conversation,
    // Formato Z-API - textMessage
    body?.data?.message?.textMessage,
    body?.message?.textMessage,
    body?.messages?.[0]?.textMessage,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string' && candidate.trim() && !isLikelyTechnicalId(candidate)) {
      return candidate;
    }
  }

  // Se não encontrou, tentar extrair de objetos aninhados recursivamente
  function findTextInObject(obj, depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') return null;
    
    if (typeof obj === 'string' && obj.trim()) {
      return obj;
    }
    
    for (const key in obj) {
      if (key.toLowerCase().includes('text') || 
          key.toLowerCase().includes('message') || 
          key.toLowerCase().includes('body') ||
          key.toLowerCase().includes('content')) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim() && !isLikelyTechnicalId(value)) {
          return value;
        }
        if (typeof value === 'object' && value !== null) {
          const found = findTextInObject(value, depth + 1);
          if (found) return found;
        }
      }
    }
    
    return null;
  }

  const foundText = findTextInObject(body);
  if (foundText) return foundText;

  return '';
}

function extractIncomingPhone(body) {
  if (!body || typeof body !== 'object') return '';

  // Tentar múltiplos formatos de payload da Z-API
  const candidates = [
    body.phone,
    body.phoneNumber,
    body.from,
    body.sender,
    body.remoteJid,
    body.contact,
    body?.data?.phone,
    body?.data?.phoneNumber,
    body?.data?.from,
    body?.data?.sender,
    body?.data?.remoteJid,
    body?.data?.contact,
    body?.message?.from,
    body?.message?.phone,
    body?.message?.phoneNumber,
    body?.message?.remoteJid,
    body?.message?.contact,
    body?.messages?.[0]?.from,
    body?.messages?.[0]?.phone,
    body?.messages?.[0]?.phoneNumber,
    body?.messages?.[0]?.remoteJid,
    body?.messages?.[0]?.contact,
    body?.conversation?.phone,
    body?.conversation?.phoneNumber,
    body?.conversation?.from,
    body?.conversation?.remoteJid,
    body?.conversation?.contact,
    // Formato Z-API comum
    body?.data?.message?.from,
    body?.data?.message?.phone,
    body?.data?.message?.phoneNumber,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      // Limpar o número (remover @s.whatsapp.net se presente)
      const cleaned = String(candidate)
        .replace('@s.whatsapp.net', '')
        .replace('@c.us', '')
        .replace('@g.us', '')
        .replace(/[^0-9]/g, '') // Remove tudo que não é número
        .trim();
      if (cleaned && cleaned.length >= 10) return cleaned; // Mínimo 10 dígitos para ser um telefone válido
    }
  }

  return '';
}

function extractFromMeFlag(body) {
  if (!body || typeof body !== 'object') return false;

  const candidates = [
    body.fromMe,
    body?.data?.fromMe,
    body?.message?.fromMe,
    body?.messages?.[0]?.fromMe,
    body?.isFromMe,
    body?.data?.isFromMe
  ];

  return candidates.some(v => v === true || v === 'true' || v === 1 || v === '1');
}

function timeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const parts = hhmm.split(':');
  if (parts.length < 2) return null;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function isWithinWindow(nowMinutes, openMinutes, closeMinutes) {
  if (openMinutes == null || closeMinutes == null) return true;

  if (openMinutes === closeMinutes) return true;

  if (closeMinutes > openMinutes) {
    return nowMinutes >= openMinutes && nowMinutes <= closeMinutes;
  }

  return nowMinutes >= openMinutes || nowMinutes <= closeMinutes;
}

function getNowInSaoPaulo() {
  const brasilNowString = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  return new Date(brasilNowString);
}

function getSaoPauloDateKey(date = getNowInSaoPaulo()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getUtcDateFromDateKey(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function getDateKeyFromUtcDate(date) {
  if (!(date instanceof Date)) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function registerWebhookSender(lojaId, phone) {
  if (!lojaId || !phone) return;
  const telefone = String(phone).trim().slice(0, 20);
  if (!telefone) return;

  try {
    const now = new Date();
    await prisma.zapi_remetente_mensagem.upsert({
      where: {
        lojaId_telefone: {
          lojaId,
          telefone,
        },
      },
      update: {
        ultimaEm: now,
        totalMensagens: { increment: 1 },
      },
      create: {
        lojaId,
        telefone,
        primeiraEm: now,
        ultimaEm: now,
        totalMensagens: 1,
      },
    });
  } catch (err) {
    throw err;
  }
}

async function shouldSendAutoMessageToday(lojaId, phone) {
  if (!phone) return false;

  const todayKey = getSaoPauloDateKey();
  const todayDate = getUtcDateFromDateKey(todayKey);
  const existing = await prisma.zapi_primeira_interacao_dia.findUnique({
    where: {
      lojaId_telefone: {
        lojaId,
        telefone: phone,
      },
    },
    select: {
      id: true,
      dataReferencia: true,
    },
  });

  if (!existing) {
    await prisma.zapi_primeira_interacao_dia.create({
      data: {
        lojaId,
        telefone: phone,
        dataReferencia: todayDate,
      },
    });
    return true;
  }

  const lastSentKey = getDateKeyFromUtcDate(existing.dataReferencia);
  if (lastSentKey === todayKey) {
    return false;
  }

  await prisma.zapi_primeira_interacao_dia.update({
    where: { id: existing.id },
    data: { dataReferencia: todayDate },
  });

  return true;
}

async function resolveLojaId(req) {
  const lojaIdParam = req.query?.lojaId;
  if (lojaIdParam && Number.isFinite(Number(lojaIdParam))) {
    return Number(lojaIdParam);
  }

  const subdominio = req.query?.subdominio;
  if (subdominio) {
    const loja = await prisma.loja.findUnique({ where: { subdominio: subdominio.toString() } });
    if (loja?.id) return loja.id;
  }

  const headerLojaId = req.headers['x-loja-id'];
  if (headerLojaId && Number.isFinite(Number(headerLojaId))) {
    return Number(headerLojaId);
  }

  return 1;
}

async function getLojaSubdomain(lojaId) {
  try {
    const loja = await prisma.loja.findUnique({ 
      where: { id: lojaId },
      select: { subdominio: true }
    });
    return loja?.subdominio || null;
  } catch (err) {
    console.error('❌ [Z-API Webhook] Erro ao buscar subdomínio da loja:', err);
    return null;
  }
}

function buildMenuLink(subdominio) {
  if (!subdominio) return null;
  
  const baseDomain = process.env.BASE_DOMAIN || 'miradelivery.com.br';
  const protocol = process.env.PROTOCOL || 'https';
  
  return `${protocol}://${subdominio}.${baseDomain}`;
}

function formatDaysOfWeek(diasAbertos) {
  if (!diasAbertos || typeof diasAbertos !== 'string') return '';
  
  const dias = diasAbertos.toString().split(',').map(s => s.trim()).filter(Boolean);
  if (dias.length === 0) return '';
  
  const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const dayNamesShort = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  
  // Mapear números dos dias (0=domingo, 1=segunda, etc.) para nomes
  const diasFormatados = dias
    .map(d => {
      const dayNum = parseInt(d);
      if (isNaN(dayNum) || dayNum < 0 || dayNum > 6) return null;
      return dayNames[dayNum];
    })
    .filter(Boolean);
  
  if (diasFormatados.length === 0) return '';
  if (diasFormatados.length === 1) return diasFormatados[0];
  if (diasFormatados.length === 7) return 'Todos os dias';
  
  // Formatar lista: "Segunda-feira, Terça-feira e Quarta-feira"
  if (diasFormatados.length === 2) {
    return diasFormatados.join(' e ');
  }
  
  const lastDay = diasFormatados.pop();
  return `${diasFormatados.join(', ')} e ${lastDay}`;
}

async function getStoreOpenStatus(lojaId) {
  const config = await prisma.configuracao_loja.findUnique({ where: { lojaId } });

  const aberto = (config?.aberto ?? true) === true;
  if (!aberto) {
    return { open: false, config, reason: 'closed_by_config' };
  }

  const now = getNowInSaoPaulo();
  const day = now.getDay();

  // Verificar se tem horários por dia configurados
  let horarioDoDia = null;
  if (config?.horariosPorDia && typeof config.horariosPorDia === 'object') {
    horarioDoDia = config.horariosPorDia[String(day)];
  }

  // Se tem horário por dia, usar ele; senão usar os dias gerais
  if (horarioDoDia) {
    // Se o dia específico está fechado
    if (!horarioDoDia.aberto) {
      return { open: false, config, reason: 'closed_by_day', horarioDoDia };
    }
    
    // Usar horários do dia específico
    const openMinutes = timeToMinutes(horarioDoDia.abertura);
    const closeMinutes = timeToMinutes(horarioDoDia.fechamento);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const within = isWithinWindow(nowMinutes, openMinutes, closeMinutes);
    if (!within) {
      return { open: false, config, reason: 'closed_by_time', horarioDoDia };
    }
    
    return { open: true, config, horarioDoDia };
  }

  // Fallback: usar configuração geral de dias
  const dias = (config?.diasAbertos || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  
  const isClosedByDay = dias.length > 0 && !dias.includes(String(day));
  
  if (isClosedByDay) {
    return { open: false, config, reason: 'closed_by_day' };
  }

  const openMinutes = timeToMinutes(config?.horaAbertura);
  const closeMinutes = timeToMinutes(config?.horaFechamento);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const within = isWithinWindow(nowMinutes, openMinutes, closeMinutes);
  if (!within) {
    return { open: false, config, reason: 'closed_by_time' };
  }
  
  return { open: true, config };
}

// Rota de teste para verificar se o webhook está acessível
router.get('/', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'Webhook Z-API está funcionando!',
    lojaId: req.query?.lojaId || 'não informado',
    timestamp: new Date().toISOString()
  });
});

router.post('/', async (req, res) => {
  try {
    console.log('🔔 [Z-API Webhook] Requisição POST recebida');

    // Responder imediatamente para evitar timeout da Z-API
    res.status(200).json({ ok: true, received: true });

    const fromMe = extractFromMeFlag(req.body);
    if (fromMe) {
      console.log('⏭️ [Z-API Webhook] Ignorando mensagem (fromMe=true)');
      return;
    }

    const lojaId = await resolveLojaId(req);
    console.log('🏪 [Z-API Webhook] Loja ID:', lojaId);

    const text = extractIncomingText(req.body);
    const phone = extractIncomingPhone(req.body);
    console.log('📱 [Z-API Webhook] Telefone:', phone);
    console.log('💬 [Z-API Webhook] Texto:', text || '(VAZIO)');

    if (!phone) {
      console.log('⚠️ [Z-API Webhook] Telefone não encontrado no payload');
      return;
    }

    // Registra/atualiza o remetente para a métrica "pessoas que mandaram mensagem".
    // Não bloqueia o fluxo: erros aqui são apenas logados.
    registerWebhookSender(lojaId, phone).catch((err) => {
      console.warn('⚠️ [Z-API Webhook] Falha ao registrar remetente da mensagem:', err?.message || err);
    });

    const wasDelivererActionHandled = await handleDelivererDeliveredAction({ prisma, text, phone, lojaId });
    if (wasDelivererActionHandled) {
      return;
    }

    const { open, config, reason } = await getStoreOpenStatus(lojaId);
    const orderFlowEnabled = isOrderFlowEnabled(config);
    const startOrderIntent = isStartOrderIntent(text);
    const categoriesIntent = normalizeText(text) === 'categorias';

    const sessionKey = getSessionKey(lojaId, phone);
    const rawExistingSession = orderSessions.get(sessionKey);

    if (rawExistingSession && rawExistingSession.step !== HANDED_OFF_STEP && isSessionInactive(rawExistingSession)) {
      markSessionHandedOff(lojaId, phone);
      console.log(`🛑 [Z-API Webhook] Fluxo encerrado por inatividade (>${INACTIVITY_TIMEOUT_MS / 60000} min). Telefone: ${phone}`);
      if (!startOrderIntent) {
        return;
      }
    }

    const handedOffSession = orderSessions.get(sessionKey);
    if (handedOffSession?.step === HANDED_OFF_STEP) {
      if (startOrderIntent) {
        clearOrderSession(lojaId, phone);
      } else {
        console.log(`⏭️ [Z-API Webhook] Cliente em atendimento humano. Bot ignorando mensagem. Telefone: ${phone}`);
        return;
      }
    }
    console.log('🕐 [Z-API Webhook] Loja:', open ? 'Aberta' : 'Fechada', reason ? `(${reason})` : '');

    // Buscar subdomínio da loja e construir o link do cardápio
    const subdominio = await getLojaSubdomain(lojaId);
    const menuLink = subdominio ? buildMenuLink(subdominio) : null;
    const templates = await getWhatsappTemplates(lojaId);

    if (!open) {
      const isGreetingMessage = isGreeting(text);
      if (!isGreetingMessage) {
        console.log('⏭️ [Z-API Webhook] Loja fechada: mensagem ignorada (não é saudação)');
        return;
      }

      // Usar horário do dia específico se disponível, senão usar geral
      const now = getNowInSaoPaulo();
      const day = now.getDay();
      let openingTime, closingTime;
      
      if (config?.horariosPorDia && typeof config.horariosPorDia === 'object') {
        const horarioDoDia = config.horariosPorDia[String(day)];
        if (horarioDoDia && horarioDoDia.abertura && horarioDoDia.fechamento) {
          openingTime = horarioDoDia.abertura;
          closingTime = horarioDoDia.fechamento;
        } else {
          openingTime = config?.horaAbertura || '08:00';
          closingTime = config?.horaFechamento || '18:00';
        }
      } else {
        openingTime = config?.horaAbertura || '08:00';
        closingTime = config?.horaFechamento || '18:00';
      }
      
      // Para os dias de funcionamento, usar horariosPorDia se disponível
      let diasFormatados = '';
      if (config?.horariosPorDia && typeof config.horariosPorDia === 'object') {
        // Extrair dias que estão abertos do horariosPorDia
        const diasAbertosComHorario = [];
        const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
        
        for (let i = 0; i <= 6; i++) {
          const horario = config.horariosPorDia[String(i)];
          if (horario && horario.aberto) {
            diasAbertosComHorario.push(dayNames[i]);
          }
        }
        
        if (diasAbertosComHorario.length > 0) {
          if (diasAbertosComHorario.length === 1) {
            diasFormatados = diasAbertosComHorario[0];
          } else if (diasAbertosComHorario.length === 2) {
            diasFormatados = diasAbertosComHorario.join(' e ');
          } else {
            const lastDay = diasAbertosComHorario.pop();
            diasFormatados = `${diasAbertosComHorario.join(', ')} e ${lastDay}`;
          }
        }
      }
      
      // Fallback: usar diasAbertos se não tiver horariosPorDia
      if (!diasFormatados) {
        const diasAbertos = config?.diasAbertos || '';
        diasFormatados = formatDaysOfWeek(diasAbertos);
      }

      const diasExtraLine = diasFormatados
        ? interpolateTemplate(templates.zapiWebhookClosedDiasExtraLine, { diasFormatados })
        : '';

      let closedDetails = '';
      if (reason === 'closed_by_day' && diasFormatados) {
        closedDetails = interpolateTemplate(templates.zapiWebhookClosedByDay, {
          diasFormatados,
          openingTime,
          closingTime,
        });
      } else if (reason === 'closed_by_time') {
        closedDetails = interpolateTemplate(templates.zapiWebhookClosedByTime, {
          openingTime,
          closingTime,
          diasExtraLine,
        });
      } else {
        closedDetails = interpolateTemplate(templates.zapiWebhookClosedGeneral, {
          openingTime,
          closingTime,
          diasExtraLine,
        });
      }

      const message = interpolateTemplate(templates.zapiWebhookStoreClosedHeader, { closedDetails });
      await sendWhatsAppMessageZApi(phone, message, lojaId);
      console.log('✅ [Z-API Webhook] Mensagem de loja fechada enviada');
      return;
    }

    if (startOrderIntent) {
      const categories = await fetchStoreCategories(lojaId);
      if (!categories.length) {
        await sendWhatsAppMessageZApi(
          phone,
          'No momento nao encontramos categorias disponiveis para pedido por aqui. Tente novamente em instantes.',
          lojaId
        );
        clearOrderSession(lojaId, phone);
        console.log('⚠️ [Z-API Webhook] Pedido por WhatsApp sem categorias disponiveis');
        return;
      }

      const registeredCustomer = await resolveCustomerByPhone(lojaId, phone);
      setOrderSession(lojaId, phone, {
        step: 'awaiting_category',
        categories: categories.map((category) => ({ id: category.id, nome: category.nome })),
        cart: [],
        customerId: registeredCustomer?.id || null,
        customerName: registeredCustomer?.name || '',
        customerPhone: registeredCustomer?.phone || normalizePhoneDigits(phone),
        savedAddresses: registeredCustomer?.addresses || [],
      });

      await sendCategoriesPrompt(phone, lojaId, categories);

      console.log('✅ [Z-API Webhook] Menu de categorias enviado');
      return;
    }

    const activeSession = getOrderSession(lojaId, phone);
    const flowRuntimeEnabled = orderFlowEnabled || startOrderIntent || categoriesIntent || Boolean(activeSession);
    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_category') {
      const selectedCategory = parseCategorySelection(text, activeSession.categories || []);
      if (!selectedCategory) {
        await sendFallbackMessage(
          lojaId,
          phone,
          'Nao entendi a categoria escolhida. Responda com o numero da categoria que voce deseja.'
        );
        return;
      }

      const products = await fetchProductsByCategory(lojaId, selectedCategory.id);
      if (!products.length) {
        await sendFallbackMessage(
          lojaId,
          phone,
          `A categoria *${selectedCategory.nome}* nao possui itens disponiveis agora.\n\nEscolha outra categoria enviando o numero correspondente.`
        );
        return;
      }

      const nextSession = buildSessionWithTimestamp({
        ...activeSession,
        step: 'awaiting_item',
        currentCategory: selectedCategory,
        products: products.map((product) => ({
          id: product.id,
          nome: product.nome,
          preco: Number(product.preco || 0),
          descricao: product.descricao || '',
          receivesFlavors: Boolean(product.recebeSabores),
          receivesComplements: Boolean(product.recebeComplementos),
          receivesAdditionals: Boolean(product.recebeAdicionais),
          maxComplements: Number(product.quantidadeComplementos || 0),
          maxFlavors: (product.categorias_sabor || []).reduce(
            (acc, rel) => acc + Number(rel?.quantidade || 0),
            0
          ),
          flavorGroups: (product.categorias_sabor || []).map((rel) => ({
            categoryName: rel?.categoriaSabor?.nome || 'Sabores',
            flavors: (rel?.categoriaSabor?.sabores || [])
              .map((flavor) => ({ id: flavor.id, nome: flavor.nome }))
              .filter((flavor) => Boolean(flavor?.nome)),
          })),
          maxAdditionals: (product.categorias_adicional || []).reduce(
            (acc, rel) => acc + Number(rel?.quantidade || 0),
            0
          ),
          additionalGroups: (product.categorias_adicional || []).map((rel) => ({
            categoryName: rel?.categoriaAdicional?.nome || 'Adicionais',
            additionals: (rel?.categoriaAdicional?.adicionais || []).map((additional) => additional.nome).filter(Boolean),
          })),
        })),
      });
      setOrderSession(lojaId, phone, nextSession);

      await sendProductsPrompt(phone, lojaId, selectedCategory.nome, products);
      console.log('✅ [Z-API Webhook] Lista de itens da categoria enviada');
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_item') {
      const selectedProduct = parseProductSelection(text, activeSession.products || []);
      if (!selectedProduct) {
        await sendFallbackMessage(lojaId, phone, 'Nao entendi o item. Responda com o numero do item da lista.');
        return;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          step: 'awaiting_observation',
          pendingItem: {
            productId: selectedProduct.id,
            name: selectedProduct.nome,
            price: Number(selectedProduct.preco || 0),
            requiresFlavors: Boolean(selectedProduct.receivesFlavors),
            acceptsComplements: Boolean(selectedProduct.receivesComplements),
            acceptsAdditionals: Boolean(selectedProduct.receivesAdditionals),
            maxFlavors: Number(selectedProduct.maxFlavors || 0),
            flavorGroups: Array.isArray(selectedProduct.flavorGroups) ? selectedProduct.flavorGroups : [],
            maxComplements: Number(selectedProduct.maxComplements || 0),
            maxAdditionals: Number(selectedProduct.maxAdditionals || 0),
            additionalGroups: Array.isArray(selectedProduct.additionalGroups) ? selectedProduct.additionalGroups : [],
            categoryName: activeSession.currentCategory?.nome || '',
            flavors: '',
            flavorIds: [],
            complements: '',
            additionals: '',
            observation: '',
            quantity: 1,
          },
        })
      );

      const currentSession = getOrderSession(lojaId, phone);
      if (!currentSession?.pendingItem) {
        await sendFallbackMessage(lojaId, phone, 'Nao foi possivel iniciar a personalizacao. Tente escolher o item novamente.');
        return;
      }

      let sessionWithOptions = currentSession;
      if (selectedProduct.receivesComplements) {
        const complements = await fetchActiveComplements(lojaId);
        sessionWithOptions = buildSessionWithTimestamp({
          ...currentSession,
          pendingItem: {
            ...currentSession.pendingItem,
            complementOptions: complements.map((item) => item.nome),
          },
        });
        setOrderSession(lojaId, phone, sessionWithOptions);
      }

      if (selectedProduct.receivesFlavors) {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...sessionWithOptions,
            step: 'awaiting_flavors',
          })
        );
        const flavorsMessage = buildFlavorPrompt({
          name: selectedProduct.nome,
          maxFlavors: selectedProduct.maxFlavors,
          flavorGroups: selectedProduct.flavorGroups,
        });
        await sendWhatsAppMessageZApi(phone, flavorsMessage, lojaId);
        return;
      }

      if (selectedProduct.receivesComplements) {
        const sessionWithComplements = getOrderSession(lojaId, phone) || sessionWithOptions;
        if (sessionWithComplements?.pendingItem) {
          setOrderSession(
            lojaId,
            phone,
            buildSessionWithTimestamp({
              ...sessionWithComplements,
              step: 'awaiting_complements',
            })
          );
          const msg = buildComplementsPrompt(sessionWithComplements.pendingItem);
          const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
          if (!result.success) {
            await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
          }
          return;
        }
        await sendFallbackMessage(lojaId, phone, 'Nao foi possivel carregar os complementos. Tente novamente.');
        return;
      }

      if (selectedProduct.receivesAdditionals) {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...currentSession,
            step: 'awaiting_additionals',
          })
        );
        const msg = buildAdditionalsPrompt(currentSession.pendingItem);
        const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
        if (!result.success) {
          await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
        }
        return;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...currentSession,
          step: 'awaiting_observation',
        })
      );
      const msg = 'Alguma observacao para esse item? (opcional)';
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_flavors') {
      const pendingItem = { ...(activeSession.pendingItem || {}) };
      if (pendingItem.requiresFlavors) {
        const providedFlavor = (text || '').trim();
        if (!providedFlavor || isSkipAnswer(text)) {
          await sendFallbackMessage(lojaId, phone, 'Para esse item, informar sabor e obrigatorio. Digite o sabor desejado.');
          return;
        }
        const selectedFlavorsCount = countFlavorEntries(providedFlavor);
        if (Number(pendingItem.maxFlavors || 0) > 0 && selectedFlavorsCount > Number(pendingItem.maxFlavors)) {
          await sendFallbackMessage(
            lojaId,
            phone,
            `Voce informou ${selectedFlavorsCount} sabores, mas o maximo permitido e ${pendingItem.maxFlavors}.`
          );
          return;
        }
        pendingItem.flavors = providedFlavor;
        pendingItem.flavorIds = resolveFlavorIdsFromPendingItem(providedFlavor, pendingItem);
      } else {
        pendingItem.flavors = isSkipAnswer(text) ? '' : text.trim();
        pendingItem.flavorIds = resolveFlavorIdsFromPendingItem(pendingItem.flavors, pendingItem);
      }
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...activeSession, pendingItem })
      );
      await goToNextCustomizationStep(lojaId, phone, { ...activeSession, pendingItem }, 'flavors');
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_complements') {
      const pendingItem = { ...(activeSession.pendingItem || {}) };
      const provided = isSkipAnswer(text) ? '' : text.trim();
      if (provided && Number(pendingItem.maxComplements || 0) > 0) {
        const count = countFlavorEntries(provided);
        if (count > Number(pendingItem.maxComplements)) {
          await sendFallbackMessage(
            lojaId,
            phone,
            `Voce informou ${count} complementos, mas o maximo permitido e ${pendingItem.maxComplements}.`
          );
          return;
        }
      }
      pendingItem.complements = provided;
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...activeSession, pendingItem })
      );
      await goToNextCustomizationStep(lojaId, phone, { ...activeSession, pendingItem }, 'complements');
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_additionals') {
      const pendingItem = { ...(activeSession.pendingItem || {}) };
      const provided = isSkipAnswer(text) ? '' : text.trim();
      if (provided && Number(pendingItem.maxAdditionals || 0) > 0) {
        const count = countFlavorEntries(provided);
        if (count > Number(pendingItem.maxAdditionals)) {
          await sendFallbackMessage(
            lojaId,
            phone,
            `Voce informou ${count} adicionais, mas o maximo permitido e ${pendingItem.maxAdditionals}.`
          );
          return;
        }
      }
      pendingItem.additionals = provided;
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...activeSession, pendingItem })
      );
      await goToNextCustomizationStep(lojaId, phone, { ...activeSession, pendingItem }, 'additionals');
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_observation') {
      const pendingItem = { ...(activeSession.pendingItem || {}) };
      pendingItem.observation = isSkipAnswer(text) ? '' : text.trim();
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({ ...activeSession, step: 'awaiting_quantity', pendingItem })
      );
      await sendWhatsAppMessageZApi(phone, 'Qual a quantidade desse item? (responda com numero)', lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_quantity') {
      const quantity = Number(normalizeText(text));
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
        await sendFallbackMessage(lojaId, phone, 'Quantidade invalida. Informe um numero inteiro maior que zero.');
        return;
      }

      const pendingItem = { ...(activeSession.pendingItem || {}) };
      pendingItem.quantity = quantity;
      const updatedCart = [...(activeSession.cart || []), pendingItem];
      const hasBeverage = getBeverageCategories(activeSession.categories || []).length > 0;

      if (hasBeverage && !normalizeText(pendingItem.categoryName).includes('bebida')) {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...activeSession,
            cart: updatedCart,
            pendingItem: null,
            step: 'awaiting_upsell_answer',
          })
        );
        const upsellMessage = 'Deseja adicionar bebida?';
        const result = await sendWhatsAppButtonListZApi(
          phone,
          upsellMessage,
          [
            { id: 'upsell_yes', label: 'Sim, adicionar' },
            { id: 'upsell_no', label: 'Nao, continuar' },
          ],
          lojaId
        );
        if (!result.success) {
          await sendWhatsAppMessageZApi(phone, `${upsellMessage}\n\n1 - Sim, adicionar\n2 - Nao, continuar`, lojaId);
        }
        return;
      }

      const summary = buildCartSummary(updatedCart);
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          cart: updatedCart,
          pendingItem: null,
          step: 'awaiting_cart_action',
        })
      );
      await sendCartActionPrompt(phone, lojaId, summary);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_upsell_answer') {
      if (parsePositiveAnswer(text)) {
        const beverageCategories = getBeverageCategories(activeSession.categories || []);
        if (!beverageCategories.length) {
          setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...activeSession, step: 'awaiting_cart_action' }));
        } else {
          const beverageCategory = beverageCategories[0];
          const beverageProducts = await fetchProductsByCategory(lojaId, beverageCategory.id);
          if (!beverageProducts.length) {
            setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...activeSession, step: 'awaiting_cart_action' }));
          } else {
            setOrderSession(
              lojaId,
              phone,
              buildSessionWithTimestamp({
                ...activeSession,
                step: 'awaiting_upsell_item',
                currentCategory: beverageCategory,
                products: beverageProducts.map((product) => ({
                  id: product.id,
                  nome: product.nome,
                  preco: Number(product.preco || 0),
                  descricao: product.descricao || '',
                })),
              })
            );
            await sendProductsPrompt(phone, lojaId, beverageCategory.nome, beverageProducts);
            return;
          }
        }
      }

      if (!parseNegativeAnswer(text) && !parsePositiveAnswer(text)) {
        await sendFallbackMessage(lojaId, phone, 'Responda: Sim, adicionar ou Nao, continuar.');
        return;
      }

      const summary = buildCartSummary(activeSession.cart || []);
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          step: 'awaiting_cart_action',
        })
      );
      await sendCartActionPrompt(phone, lojaId, summary);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_upsell_item') {
      const selectedProduct = parseProductSelection(text, activeSession.products || []);
      if (!selectedProduct) {
        await sendFallbackMessage(lojaId, phone, 'Nao entendi o item da bebida. Responda com o numero.');
        return;
      }
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          step: 'awaiting_upsell_quantity',
          pendingItem: {
            productId: selectedProduct.id,
            name: selectedProduct.nome,
            price: Number(selectedProduct.preco || 0),
            categoryName: activeSession.currentCategory?.nome || 'Bebidas',
            flavors: '',
            complements: '',
            additionals: '',
            observation: '',
            quantity: 1,
          },
        })
      );
      await sendWhatsAppMessageZApi(phone, 'Qual a quantidade da bebida?', lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_upsell_quantity') {
      const quantity = Number(normalizeText(text));
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
        await sendFallbackMessage(lojaId, phone, 'Quantidade invalida. Informe um numero inteiro maior que zero.');
        return;
      }
      const pendingItem = { ...(activeSession.pendingItem || {}) };
      pendingItem.quantity = quantity;
      const updatedCart = [...(activeSession.cart || []), pendingItem];
      const summary = buildCartSummary(updatedCart);

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          cart: updatedCart,
          pendingItem: null,
          step: 'awaiting_cart_action',
        })
      );
      await sendCartActionPrompt(phone, lojaId, summary);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_cart_action') {
      const action = parseCartAction(text);
      if (action === 'add_more') {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...activeSession,
            step: 'awaiting_category',
            currentCategory: null,
            products: [],
          })
        );
        await sendCategoriesPrompt(phone, lojaId, activeSession.categories || []);
        return;
      }

      if (action === 'finalize') {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...activeSession,
            step: 'awaiting_delivery_type',
          })
        );
        await sendDeliveryTypePrompt(phone, lojaId);
        return;
      }

      if (action === 'cancel') {
        clearOrderSession(lojaId, phone);
        await sendWhatsAppMessageZApi(phone, 'Pedido cancelado. Quando quiser, envie: Realizar pedido por aqui', lojaId);
        return;
      }

      await sendFallbackMessage(lojaId, phone, 'Escolha uma opcao: adicionar, finalizar ou cancelar.');
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_delivery_type') {
      const deliveryType = parseDeliveryTypeAction(text);
      if (!deliveryType) {
        await sendFallbackMessage(lojaId, phone, 'Escolha uma opcao: 🚚 Entrega ou 🏪 Retirada.');
        return;
      }

      if (deliveryType === 'pickup') {
        const checkoutConfig = await fetchCheckoutConfig(lojaId);
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...activeSession,
            deliveryType: 'pickup',
            deliveryFee: 0,
            step: 'awaiting_payment_method',
          })
        );
        await sendPaymentMethodPrompt(phone, lojaId, checkoutConfig, 'pickup');
        return;
      }

      const deliveryScheduleConfig = await fetchDeliveryScheduleConfig(lojaId);
      const deliveryOpenStatus = isDeliveryOpenNow(deliveryScheduleConfig);
      if (!deliveryOpenStatus.open) {
        await sendFallbackMessage(
          lojaId,
          phone,
          'No momento o horario de *Entrega* esta encerrado. Para continuar agora, escolha *Retirada*.'
        );
        return;
      }

      const neighborhoods = await fetchDeliveryNeighborhoods(lojaId);
      if (!neighborhoods.length) {
        await sendFallbackMessage(lojaId, phone, 'No momento nao atendemos entrega por bairro cadastrado. Escolha retirada.');
        return;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          deliveryType: 'delivery',
          deliveryAddress: {},
          neighborhoods: neighborhoods.map((n) => ({
            id: n.id,
            nome: n.nome,
            nomeNormalizado: n.nomeNormalizado,
            taxaEntrega: Number(n.taxaEntrega || 0),
          })),
          step: Array.isArray(activeSession.savedAddresses) && activeSession.savedAddresses.length > 0
            ? 'awaiting_saved_address_choice'
            : 'awaiting_address_street',
        })
      );
      if (Array.isArray(activeSession.savedAddresses) && activeSession.savedAddresses.length > 0) {
        await sendSavedAddressesPrompt(
          phone,
          lojaId,
          activeSession.customerName,
          activeSession.savedAddresses
        );
      } else {
        await sendWhatsAppMessageZApi(phone, 'Informe a *Rua* para entrega:', lojaId);
      }
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_saved_address_choice') {
      const addresses = Array.isArray(activeSession.savedAddresses) ? activeSession.savedAddresses : [];
      const selection = parseSavedAddressSelection(text, addresses);
      if (!selection) {
        await sendFallbackMessage(
          lojaId,
          phone,
          'Escolha um endereco da lista pelo numero, ou responda 0 para informar outro endereco.'
        );
        return;
      }

      if (selection.type === 'new') {
        setOrderSession(
          lojaId,
          phone,
          buildSessionWithTimestamp({
            ...activeSession,
            deliveryAddress: {},
            step: 'awaiting_address_street',
          })
        );
        await sendWhatsAppMessageZApi(phone, 'Informe a *Rua* para entrega:', lojaId);
        return;
      }

      const selectedAddress = selection.address;
      const neighborhoods = activeSession.neighborhoods || [];
      const selectedNeighborhood = parseNeighborhoodSelection(selectedAddress.neighborhood, neighborhoods);
      const sessionWithAddress = buildSessionWithTimestamp({
        ...activeSession,
        deliveryAddress: {
          street: selectedAddress.street,
          number: selectedAddress.number,
          complement: selectedAddress.complement || '',
          neighborhood: selectedAddress.neighborhood,
          reference: selectedAddress.reference || '',
        },
        deliveryFee: Number(selectedNeighborhood?.taxaEntrega || 0),
      });

      if (!selectedNeighborhood) {
        setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...sessionWithAddress, step: 'awaiting_address_neighborhood' }));
        await sendNeighborhoodsPrompt(phone, lojaId, neighborhoods);
        return;
      }

      if (!selectedAddress.reference) {
        setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...sessionWithAddress, step: 'awaiting_address_reference' }));
        await sendWhatsAppMessageZApi(phone, 'Informe um ponto de referencia:', lojaId);
        return;
      }

      await proceedToPaymentAfterDeliveryAddress(lojaId, phone, sessionWithAddress);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_address_street') {
      const street = (text || '').trim();
      if (!street) {
        await sendFallbackMessage(lojaId, phone, 'Informe uma rua valida para continuar.');
        return;
      }
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          deliveryAddress: { ...(activeSession.deliveryAddress || {}), street },
          step: 'awaiting_address_number',
        })
      );
      await sendWhatsAppMessageZApi(phone, 'Informe o *numero*:', lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_address_number') {
      const number = (text || '').trim();
      if (!number) {
        await sendFallbackMessage(lojaId, phone, 'Informe um numero valido para continuar.');
        return;
      }
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          deliveryAddress: { ...(activeSession.deliveryAddress || {}), number },
          step: 'awaiting_address_complement',
        })
      );
      const msg = 'Informe o complemento (opcional):';
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\nPara pular, responda: Pular`, lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_address_complement') {
      const complement = isSkipAnswer(text) ? '' : (text || '').trim();
      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          deliveryAddress: { ...(activeSession.deliveryAddress || {}), complement },
          step: 'awaiting_address_neighborhood',
        })
      );
      await sendNeighborhoodsPrompt(phone, lojaId, activeSession.neighborhoods || []);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_address_neighborhood') {
      const neighborhoods = activeSession.neighborhoods || [];
      const selected = parseNeighborhoodSelection(text, neighborhoods);
      if (!selected) {
        await sendFallbackMessage(lojaId, phone, 'Bairro nao atendido. Escolha um bairro cadastrado da lista.');
        return;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          deliveryFee: Number(selected.taxaEntrega || 0),
          deliveryAddress: { ...(activeSession.deliveryAddress || {}), neighborhood: selected.nome },
          step: 'awaiting_address_reference',
        })
      );
      await sendWhatsAppMessageZApi(phone, 'Informe um ponto de referencia:', lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_address_reference') {
      const reference = (text || '').trim();
      if (!reference || isSkipAnswer(text)) {
        await sendFallbackMessage(lojaId, phone, 'Ponto de referencia obrigatorio. Informe um ponto de referencia valido para continuar.');
        return;
      }
      const updatedSession = buildSessionWithTimestamp({
        ...activeSession,
        deliveryAddress: { ...(activeSession.deliveryAddress || {}), reference },
      });
      await proceedToPaymentAfterDeliveryAddress(lojaId, phone, updatedSession);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_payment_method') {
      const method = parsePaymentMethodAction(text);
      if (!method) {
        await sendFallbackMessage(lojaId, phone, 'Escolha um metodo de pagamento: Pix, Cartao na entrega ou Dinheiro.');
        return;
      }

      const nextSession = buildSessionWithTimestamp({
        ...activeSession,
        paymentMethod: method,
      });

      if (method === 'CASH_ON_DELIVERY') {
        setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...nextSession, step: 'awaiting_cash_change' }));
        await sendWhatsAppMessageZApi(phone, 'Precisa de troco para quanto? (ex: 100). Se nao, responda: sem troco', lojaId);
        return;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...nextSession,
          step: 'awaiting_order_observation',
        })
      );
      const msg = 'Tem alguma observacao para o pedido? (opcional)';
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_cash_change') {
      const normalized = normalizeIntentText(text);
      const noChange = normalized === 'sem troco' || normalized === 'nao' || normalized === 'não';
      const numeric = Number(String(text || '').replace(',', '.').replace(/[^\d.]/g, ''));
      let changeText = 'Sem troco';
      if (!noChange) {
        if (!Number.isFinite(numeric) || numeric <= 0) {
          await sendFallbackMessage(lojaId, phone, 'Valor de troco invalido. Informe um numero (ex: 100) ou "sem troco".');
          return;
        }
        changeText = `Troco para R$ ${formatCurrency(numeric)}`;
      }

      setOrderSession(
        lojaId,
        phone,
        buildSessionWithTimestamp({
          ...activeSession,
          cashChangeText: changeText,
          cashChangeValue: noChange ? null : numeric,
          step: 'awaiting_order_observation',
        })
      );
      const msg = 'Tem alguma observacao para o pedido? (opcional)';
      const result = await sendWhatsAppButtonListZApi(phone, msg, [{ id: 'skip_field', label: 'Pular' }], lojaId);
      if (!result.success) await sendWhatsAppMessageZApi(phone, `${msg}\n\nPara pular, responda: Pular`, lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_order_observation') {
      const orderObservation = isSkipAnswer(text) ? '' : (text || '').trim();
      const sessionWithObservation = buildSessionWithTimestamp({
        ...activeSession,
        orderObservation,
      });
      if (sessionWithObservation.customerName && String(sessionWithObservation.customerName).trim()) {
        await finalizeWhatsappOrder(lojaId, phone, sessionWithObservation);
        return;
      }

      setOrderSession(lojaId, phone, buildSessionWithTimestamp({ ...sessionWithObservation, step: 'awaiting_customer_name' }));
      await sendWhatsAppMessageZApi(phone, 'Qual o nome do cliente para finalizar o pedido?', lojaId);
      return;
    }

    if (flowRuntimeEnabled && activeSession?.step === 'awaiting_customer_name') {
      const customerName = (text || '').trim();
      if (!customerName) {
        await sendFallbackMessage(lojaId, phone, 'Informe um nome valido para continuar.');
        return;
      }

      const finalSession = buildSessionWithTimestamp({
        ...activeSession,
        customerName,
      });

      await finalizeWhatsappOrder(lojaId, phone, finalSession);
      return;
    }

    if (flowRuntimeEnabled && categoriesIntent) {
      const categories = await fetchStoreCategories(lojaId);
      if (!categories.length) {
        await sendWhatsAppMessageZApi(phone, 'No momento nao ha categorias disponiveis.', lojaId);
        return;
      }

      const registeredCustomer = await resolveCustomerByPhone(lojaId, phone);
      setOrderSession(lojaId, phone, {
        step: 'awaiting_category',
        categories: categories.map((category) => ({ id: category.id, nome: category.nome })),
        customerId: registeredCustomer?.id || null,
        customerName: registeredCustomer?.name || '',
        customerPhone: registeredCustomer?.phone || normalizePhoneDigits(phone),
        savedAddresses: registeredCustomer?.addresses || [],
      });
      await sendCategoriesPrompt(phone, lojaId, categories);
      return;
    }

    const shouldSendMessage = await shouldSendAutoMessageToday(lojaId, phone);
    const shouldBypassDailyGate = startOrderIntent || categoriesIntent || Boolean(activeSession);
    if (!shouldSendMessage && !shouldBypassDailyGate) {
      console.log('⏭️ [Z-API Webhook] Loja aberta: primeira mensagem do dia ja respondida para este contato');
      return;
    }

    // Saudação: um único link no template {{menuLink}} — cliente cadastrado recebe URL com token no lugar do cardápio base
    let menuLinkForTemplate = menuLink;
    let identityExtra = '';
    if (menuLink) {
      const registeredForMagic = await resolveCustomerByPhone(lojaId, phone);
      if (registeredForMagic && registeredForMagic.funcao === 'user') {
        try {
          const magicUrl = await getMagicLoginUrlForUsuario(lojaId, registeredForMagic.id);
          if (magicUrl) {
            menuLinkForTemplate = magicUrl;
          }
        } catch (magicErr) {
          console.error('❌ [Z-API Webhook] Falha ao criar link mágico:', magicErr?.message || magicErr);
        }
      } else if (!registeredForMagic) {
        identityExtra =
          '\n\nAbra o link para ver o cardápio. Ao finalizar o pedido, cadastre-se sem senha.';
      }
    }

    const baseMessage =
      (menuLinkForTemplate
        ? interpolateTemplate(templates.zapiWebhookGreetingWithMenu, { menuLink: menuLinkForTemplate })
        : interpolateTemplate(templates.zapiWebhookGreetingNoMenu, {})) + identityExtra;

    if (menuLink && orderFlowEnabled) {
      const buttons = [{ id: START_ORDER_BUTTON_ID, label: 'Realizar pedido por aqui' }];
      const buttonResult = await sendWhatsAppButtonListZApi(phone, baseMessage, buttons, lojaId);

      if (!buttonResult.success) {
        await sendWhatsAppMessageZApi(
          phone,
          `${baseMessage}\n\nPara pedir por aqui, responda: *Realizar pedido por aqui*`,
          lojaId
        );
      }
    } else {
      await sendWhatsAppMessageZApi(phone, baseMessage, lojaId);
    }
    console.log('✅ [Z-API Webhook] Mensagem de saudação enviada');

  } catch (err) {
    console.error('❌ [Z-API Webhook] Erro:', err.message);
  }
});

module.exports = router;
