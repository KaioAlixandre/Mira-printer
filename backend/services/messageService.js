// Serviço para envio de mensagens (WhatsApp/SMS)
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { DEFAULT_WHATSAPP_TEMPLATES } = require('../constants/defaultWhatsappMessages');
const prisma = new PrismaClient();
const deliveryShiftNotificationControl = new Map();
let deliveryShiftNotifierInterval = null;
let deliveryShiftNotifierRunning = false;

async function getWhatsappTemplates(lojaId) {
  try {
    if (!lojaId) {
      return { ...DEFAULT_WHATSAPP_TEMPLATES };
    }
    const cfg = await prisma.configuracao_loja.findUnique({ where: { lojaId } });
    const custom =
      cfg?.mensagensWhatsapp && typeof cfg.mensagensWhatsapp === 'object' && !Array.isArray(cfg.mensagensWhatsapp)
        ? cfg.mensagensWhatsapp
        : {};
    const merged = { ...DEFAULT_WHATSAPP_TEMPLATES };
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(merged, k)) {
        merged[k] = v;
      }
    }
    return merged;
  } catch (e) {
    return { ...DEFAULT_WHATSAPP_TEMPLATES };
  }
}

function interpolateTemplate(template, vars) {
  if (template == null || typeof template !== 'string') return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? '' : String(val);
  }).trim();
}

// Função auxiliar para obter detalhes de retirada da loja
async function getStorePickupDetails(lojaId) {
  let storeConfig = null;
  try {
    if (lojaId) {
      storeConfig = await prisma.configuracao_loja.findUnique({ where: { lojaId } });
    }
    if (!storeConfig) {
      storeConfig = await prisma.configuracao_loja.findFirst();
    }
  } catch (err) {
    console.warn('⚠️ Erro ao buscar configuração da loja:', err.message);
  }

  const rawStoreName = (storeConfig?.nomeLoja || '').trim();
  let storeName = rawStoreName || 'Mira Delivery';

  // Fallback: buscar nome da loja na tabela 'loja' caso nomeLoja esteja vazio
  if (!rawStoreName && lojaId) {
    try {
      const loja = await prisma.loja.findUnique({ where: { id: lojaId } });
      if (loja?.nome) {
        storeName = loja.nome;
      }
    } catch (err) {
      console.warn('⚠️ Erro ao buscar nome da loja (fallback):', err.message);
    }
  }
  const ruaLoja = (storeConfig?.ruaLoja || '').trim();
  const numeroLoja = (storeConfig?.numeroLoja || '').trim();
  const bairroLoja = (storeConfig?.bairroLoja || '').trim();
  const pontoRefLoja = (storeConfig?.pontoReferenciaLoja || '').trim();
  const enderecoMontado = [ruaLoja, numeroLoja ? `Nº ${numeroLoja}` : '', bairroLoja].filter(Boolean).join(', ');
  const enderecoLoja = (storeConfig?.enderecoLoja || '').trim();
  const enderecoPartes = enderecoMontado || enderecoLoja;
  const estimativaEntrega = (storeConfig?.estimativaEntrega || '').trim();

  return {
    storeConfig,
    storeName,
    enderecoPartes,
    pontoRefLoja,
    estimativaEntrega,
  };
}

// Função auxiliar para parsear opcoesSelecionadasSnapshot
function parseOptionsSnapshot(snapshot) {
    if (!snapshot) {
        return null;
    }
    
    if (typeof snapshot === 'object' && snapshot !== null) {
        return snapshot;
    }
    
    if (typeof snapshot === 'string') {
        try {
            return JSON.parse(snapshot);
        } catch (err) {
            console.warn('⚠️ Erro ao fazer parse do opcoesSelecionadasSnapshot:', err.message);
            return null;
        }
    }
    
    return null;
}

function getPreferredCustomerPhone(order) {
    return (
        order?.telefoneEntrega ||
        order?.shippingPhone ||
        order?.user?.phone ||
        order?.usuario?.telefone ||
        null
    );
}

/** Telefone do cliente para confirmação de entrega: prioriza o número gravado no pedido (`telefoneEntrega`). */
function getCustomerPhoneForDeliveredConfirmation(order) {
  const trim = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  };
  return (
    trim(order?.telefoneEntrega) ||
    trim(order?.shippingPhone) ||
    trim(order?.usuario?.telefone) ||
    trim(order?.user?.phone) ||
    null
  );
}

// Função auxiliar para formatar item com sabores e complementos
async function formatOrderItem(item, allFlavors = []) {
    try {
        const productName = item.produto?.nome || item.product?.name || 'Produto';
        const quantity = item.quantidade || item.quantity || 1;
        
        // Buscar complementos (pode estar em diferentes estruturas)
        const complementosList = [];
        if (item.complementos) {
            item.complementos.forEach(ic => {
                const complementName = ic.complemento?.nome || ic.complemento?.name || ic.nome || ic.name;
                if (complementName) {
                    complementosList.push(complementName);
                }
            });
        }
        if (item.item_pedido_complementos) {
            item.item_pedido_complementos.forEach(ic => {
                const complementName = ic.complemento?.nome || ic.complemento?.name;
                if (complementName) {
                    complementosList.push(complementName);
                }
            });
        }

        // Buscar adicionais (item_pedido_adicional: quantidade + adicional.nome)
        const adicionaisList = [];
        if (item.adicionais && item.adicionais.length > 0) {
            item.adicionais.forEach(ia => {
                const additionalName = ia.adicional?.nome || ia.adicional?.name;
                if (additionalName) {
                    const qty = ia.quantidade || 1;
                    adicionaisList.push(`${qty}x ${additionalName}`);
                }
            });
        }
        if (item.item_pedido_adicionais && item.item_pedido_adicionais.length > 0) {
            item.item_pedido_adicionais.forEach(ia => {
                const additionalName = ia.adicional?.nome || ia.adicional?.name;
                if (additionalName) {
                    const qty = ia.quantidade || 1;
                    adicionaisList.push(`${qty}x ${additionalName}`);
                }
            });
        }
        
        // Buscar sabores do opcoesSelecionadasSnapshot e também da relação item_pedido_sabores
        const saboresList = [];
        
        if (item.sabores) {
            item.sabores.forEach(s => {
                const saborName = s.sabor?.nome || s.sabor?.name || s.nome || s.name;
                if (saborName) {
                    saboresList.push(saborName);
                }
            });
        }
        if (item.item_pedido_sabores) {
            item.item_pedido_sabores.forEach(s => {
                const saborName = s.sabor?.nome || s.sabor?.name;
                if (saborName) {
                    saboresList.push(saborName);
                }
            });
        }
        
        const optionsSnapshot = item.opcoesSelecionadasSnapshot || item.selectedOptionsSnapshot;
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

        // Buscar observação do item no opcoesSelecionadasSnapshot
        const observacao = parsedSnapshot?.observacao || '';
        if (observacao.trim()) {
            itemText += `\n  📝 Obs: ${observacao.trim()}`;
        }
        
        return itemText;
    } catch (error) {
        console.error('❌ Erro ao formatar item:', error);
        const productName = item.produto?.nome || item.product?.name || 'Produto';
        const quantity = item.quantidade || item.quantity || 1;
        return `• ${quantity}x ${productName}`;
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

// Função para verificar se um número possui WhatsApp usando a Z-API
async function checkPhoneExistsWhatsApp(phone, lojaId) {
  try {
    let cleanPhone = phone.replace(/\D/g, '');
    
    // Garantir que o número tem o código do país (55) apenas uma vez
    // Se já começar com 55, não adicionar novamente
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = `55${cleanPhone}`;
    }
    
    const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
    // Usar o número como path parameter conforme documentação
    const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/phone-exists/${cleanPhone}`;

    console.log(`🔍 [Z-API] Verificando se número possui WhatsApp: ${cleanPhone}`);
    console.log(`🔍 [Z-API] URL: ${zapApiUrl}`);

    const response = await axios.get(zapApiUrl, {
      headers: {
        'client-token': zapApiClientToken
      }
    });

    console.log(`📋 [Z-API] Resposta completa:`, JSON.stringify(response.data, null, 2));
    
    const exists = response.data?.exists === true;
    console.log(`✅ [Z-API] Número ${exists ? 'possui' : 'não possui'} WhatsApp: ${cleanPhone}`);
    
    return { 
      success: true, 
      exists,
      response: response.data 
    };
  } catch (error) {
    console.error('❌ [Z-API] Erro ao verificar número:', error.response?.data || error.message);
    console.error('❌ [Z-API] Detalhes do erro:', error.response?.status, error.response?.statusText);
    return { 
      success: false, 
      exists: false, 
      error: error.message 
    };
  }
}

// Função para enviar mensagem via WhatsApp usando a Z-API
async function sendWhatsAppMessageZApi(phone, message, lojaId) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
    const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-text`;

    console.log(`📱 [Z-API] Enviando mensagem para: 55${cleanPhone}`);

    const response = await axios.post(
      zapApiUrl,
      {
        phone: `55${cleanPhone}`,
        message
      },
      {
        headers: {
          'client-token': zapApiClientToken
        }
      }
    );

    console.log('✅ [Z-API] Mensagem enviada com sucesso:', response.status);
    return { success: true, response: response.data };
  } catch (error) {
    console.error('❌ [Z-API] Erro ao enviar mensagem:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// Função para enviar mensagem com botões (button list) via Z-API
async function sendWhatsAppButtonListZApi(phone, message, buttons, lojaId) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
    const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-button-list`;

    const safeButtons = Array.isArray(buttons)
      ? buttons
          .filter((b) => b && typeof b.label === 'string' && b.label.trim())
          .slice(0, 3)
          .map((b, index) => ({
            id: String(b.id || `btn_${index + 1}`),
            label: String(b.label).trim(),
          }))
      : [];

    if (!message || safeButtons.length === 0) {
      return { success: false, error: 'Mensagem ou botões inválidos para send-button-list' };
    }

    console.log(`📱 [Z-API] Enviando mensagem com botões para: 55${cleanPhone}`);

    const response = await axios.post(
      zapApiUrl,
      {
        phone: `55${cleanPhone}`,
        message,
        buttonList: {
          buttons: safeButtons,
        },
      },
      {
        headers: {
          'client-token': zapApiClientToken,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ [Z-API] Mensagem com botões enviada com sucesso:', response.status);
    return { success: true, response: response.data };
  } catch (error) {
    console.error('❌ [Z-API] Erro ao enviar mensagem com botões:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// Função para enviar lista de opções (option list) via Z-API
async function sendWhatsAppOptionListZApi(phone, message, options, lojaId, config = {}) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    const { zapApiToken, zapApiInstance, zapApiClientToken } = await getZApiCredentials(lojaId);
    const zapApiUrl = `https://api.z-api.io/instances/${zapApiInstance}/token/${zapApiToken}/send-option-list`;

    const safeOptions = Array.isArray(options)
      ? options
          .filter((o) => o && typeof o.title === 'string' && o.title.trim())
          .slice(0, 30)
          .map((o, index) => ({
            id: String(o.id || `opt_${index + 1}`),
            title: String(o.title).trim(),
            description: typeof o.description === 'string' ? o.description.trim() : '',
          }))
      : [];

    if (!message || safeOptions.length === 0) {
      return { success: false, error: 'Mensagem ou opções inválidas para send-option-list' };
    }

    const optionTitle = typeof config.title === 'string' && config.title.trim()
      ? config.title.trim()
      : 'Selecione uma opção';
    const buttonLabel = typeof config.buttonLabel === 'string' && config.buttonLabel.trim()
      ? config.buttonLabel.trim()
      : 'Ver opções';

    const response = await axios.post(
      zapApiUrl,
      {
        phone: `55${cleanPhone}`,
        message,
        optionList: {
          title: optionTitle,
          buttonLabel,
          options: safeOptions,
        },
      },
      {
        headers: {
          'client-token': zapApiClientToken,
          'Content-Type': 'application/json',
        },
      }
    );

    return { success: true, response: response.data };
  } catch (error) {
    console.error('❌ [Z-API] Erro ao enviar option list:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
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

function parseHourToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const [hhRaw, mmRaw] = hhmm.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function getStoreClosingHourForToday(config, now = getNowInSaoPaulo()) {
  const fallbackClosingHour = config?.horaFechamento || DELIVERY_SHIFT_SUMMARY_TIME_SAO_PAULO;
  const schedule = config?.horariosPorDia;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return fallbackClosingHour;
  }

  const todayKey = String(now.getDay());
  const todaySchedule = schedule[todayKey];
  if (
    todaySchedule &&
    typeof todaySchedule === 'object' &&
    todaySchedule.aberto === true &&
    typeof todaySchedule.fechamento === 'string' &&
    todaySchedule.fechamento.trim()
  ) {
    return todaySchedule.fechamento.trim();
  }

  return fallbackClosingHour;
}

/** Horário fixo (America/Sao_Paulo) para enviar o resumo do dia aos entregadores. */
const DELIVERY_SHIFT_SUMMARY_TIME_SAO_PAULO = '23:57';

function formatAvgMinutesLikeMetrics(minutesTotal) {
  if (!Number.isFinite(minutesTotal) || minutesTotal <= 0) return 'sem dados';
  const rounded = Number(minutesTotal.toFixed(1));
  return `${rounded} min`;
}

function formatCurrencyBRL(value) {
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return safeValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function maybeNotifyManagerDailyMetricsByStore(lojaId, endHour, now = getNowInSaoPaulo()) {
  const endHourMinutes = parseHourToMinutes(endHour);
  if (endHourMinutes == null) return;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < endHourMinutes) return;

  const todayKey = getSaoPauloDateKey(now);
  const controlKey = `manager:${lojaId}:${todayKey}`;
  if (deliveryShiftNotificationControl.has(controlKey)) return;

  const storeConfig = await prisma.configuracao_loja.findUnique({
    where: { lojaId },
    select: { telefoneGerente: true },
  });
  const managerPhone = (storeConfig?.telefoneGerente || '').trim();
  if (!managerPhone) {
    deliveryShiftNotificationControl.set(controlKey, true);
    return;
  }

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const dateReference = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [store, ordersToday, deliveredOrdersCount, firstInteractionsCount, sendersAgg, topProductToday] = await Promise.all([
    prisma.loja.findUnique({
      where: { id: lojaId },
      select: { nome: true },
    }),
    prisma.pedido.findMany({
      where: {
        lojaId,
        atualizadoEm: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
      select: {
        id: true,
        status: true,
        precoTotal: true,
      },
    }),
    prisma.pedido.count({
      where: {
        lojaId,
        status: 'delivered',
        atualizadoEm: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
    }),
    prisma.zapi_primeira_interacao_dia.count({
      where: {
        lojaId,
        dataReferencia: dateReference,
      },
    }),
    prisma.zapi_remetente_mensagem.aggregate({
      where: {
        lojaId,
        ultimaEm: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
      _sum: {
        totalMensagens: true,
      },
    }),
    prisma.item_pedido.groupBy({
      by: ['produtoId'],
      where: {
        pedido: {
          lojaId,
          atualizadoEm: {
            gte: dayStart,
            lte: dayEnd,
          },
          status: { in: ['delivered', 'closed'] },
        },
      },
      _sum: {
        quantidade: true,
      },
      orderBy: {
        _sum: {
          quantidade: 'desc',
        },
      },
      take: 1,
    }),
  ]);

  const totalOrders = ordersToday.length;
  const completedStatuses = new Set(['delivered', 'closed']);
  const finalizedOrders = ordersToday.filter((order) => completedStatuses.has(order.status));
  const revenue = finalizedOrders.reduce((acc, order) => acc + Number(order.precoTotal || 0), 0);
  const averageTicket = finalizedOrders.length > 0 ? revenue / finalizedOrders.length : 0;
  const uniquePeopleWhatsapp = firstInteractionsCount || 0;
  const totalWhatsappMessages = Number(sendersAgg?._sum?.totalMensagens || 0);
  const storeName = store?.nome || 'sua loja';
  const bestSeller = topProductToday?.[0] || null;
  let bestSellerText = 'Nenhum produto vendido';
  if (bestSeller?.produtoId) {
    const topProduct = await prisma.produto.findUnique({
      where: { id: bestSeller.produtoId },
      select: { nome: true },
    });
    const topProductName = topProduct?.nome || 'Produto removido';
    const topQuantity = Number(bestSeller?._sum?.quantidade || 0);
    bestSellerText = `${topProductName} (${topQuantity} vendidos)`;
  }

  const message =
    `Resumo diário ${storeName} (${todayKey})\n\n` +
    `Pedidos do dia: ${totalOrders}\n` +
    `Pedidos finalizados: ${finalizedOrders.length}\n` +
    `Entregas concluídas: ${deliveredOrdersCount}\n` +
    `Faturamento: ${formatCurrencyBRL(revenue)}\n` +
    `Ticket médio: ${formatCurrencyBRL(averageTicket)}\n` +
    `Produto mais vendido: ${bestSellerText}\n` +
    `Número de pessoas que entraram em contato: ${uniquePeopleWhatsapp}\n`;

  await sendWhatsAppMessageZApi(managerPhone, message, lojaId);
  deliveryShiftNotificationControl.set(controlKey, true);
}

async function maybeNotifyEndOfDeliveryShiftByStore(lojaId, endHour, now = getNowInSaoPaulo()) {
  const endHourMinutes = parseHourToMinutes(endHour);
  if (endHourMinutes == null) return;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < endHourMinutes) return;

  const todayKey = getSaoPauloDateKey(now);
  const controlKey = `${lojaId}:${todayKey}`;
  if (deliveryShiftNotificationControl.has(controlKey)) return;

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const activeDeliverers = await prisma.entregador.findMany({
    where: {
      lojaId,
      ativo: true,
    },
    select: {
      id: true,
      telefone: true,
    },
  });

  if (!activeDeliverers.length) {
    deliveryShiftNotificationControl.set(controlKey, true);
    return;
  }

  const deliveredOrdersToday = await prisma.pedido.findMany({
    where: {
      lojaId,
      status: 'delivered',
      atualizadoEm: {
        gte: dayStart,
        lte: dayEnd,
      },
      entregadorId: {
        not: null,
      },
    },
    select: {
      entregadorId: true,
      saiuParaEntregaEm: true,
      atualizadoEm: true,
    },
  });

  for (const deliverer of activeDeliverers) {
    if (!deliverer.telefone) continue;

    const delivererOrders = deliveredOrdersToday.filter((order) => order.entregadorId === deliverer.id);
    const totalDeliveries = delivererOrders.length;

    const durationsInMinutes = delivererOrders
      .filter((order) => order.saiuParaEntregaEm && order.atualizadoEm)
      .map((order) => {
        const diffMs = order.atualizadoEm.getTime() - order.saiuParaEntregaEm.getTime();
        return diffMs > 0 ? diffMs / (1000 * 60) : null;
      })
      .filter((value) => Number.isFinite(value));

    const averageMinutes = durationsInMinutes.length
      ? durationsInMinutes.reduce((acc, value) => acc + value, 0) / durationsInMinutes.length
      : null;

    const avgTimeText = averageMinutes != null ? formatAvgMinutesLikeMetrics(averageMinutes) : 'sem dados';

    const message =
      'Entregas finalizadas por hoje!\n\n' +
      `Voce realizou um total de ${totalDeliveries} entregas hoje.\n\n` +
      `No tempo medio de ${avgTimeText} para entregar o pedido.`;

    await sendWhatsAppMessageZApi(deliverer.telefone, message, lojaId);
  }

  deliveryShiftNotificationControl.set(controlKey, true);
}

async function runAutomaticDeliveryShiftNotifierCycle() {
  if (deliveryShiftNotifierRunning) return;
  deliveryShiftNotifierRunning = true;
  try {
    const now = getNowInSaoPaulo();
    const stores = await prisma.configuracao_loja.findMany({
      select: {
        lojaId: true,
        horaFechamento: true,
        horariosPorDia: true,
      },
    });

    for (const row of stores) {
      if (!row.lojaId) continue;
      const storeClosingHour = getStoreClosingHourForToday(row, now);
      await maybeNotifyEndOfDeliveryShiftByStore(
        row.lojaId,
        DELIVERY_SHIFT_SUMMARY_TIME_SAO_PAULO,
        now,
      );
      await maybeNotifyManagerDailyMetricsByStore(row.lojaId, storeClosingHour, now);
    }
  } catch (error) {
    console.error('❌ [MessageService] Erro no ciclo automático do resumo diário para entregadores:', error.message);
  } finally {
    deliveryShiftNotifierRunning = false;
  }
}

function startAutomaticDeliveryShiftNotifier(intervalMs = 60 * 1000) {
  if (deliveryShiftNotifierInterval) return;

  runAutomaticDeliveryShiftNotifierCycle();
  deliveryShiftNotifierInterval = setInterval(runAutomaticDeliveryShiftNotifierCycle, intervalMs);
  if (typeof deliveryShiftNotifierInterval.unref === 'function') {
    deliveryShiftNotifierInterval.unref();
  }
  console.log(
    `⏰ [MessageService] Agendador de resumo diário para entregadores iniciado (disparo após ${DELIVERY_SHIFT_SUMMARY_TIME_SAO_PAULO} America/Sao_Paulo)`,
  );
}

// Serviço para notificação de confirmação de entrega
const sendDeliveredConfirmationNotification = async (order) => {
  try {
    console.log('📦 [MessageService] Enviando confirmação de entrega ao cliente');
    
    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    const templates = await getWhatsappTemplates(order?.lojaId);
    const dailyNumber = String(order.dailyNumber || order.id);
    const customerMessage = interpolateTemplate(templates.deliveredConfirmation, { dailyNumber });

    let customerPhone = getCustomerPhoneForDeliveredConfirmation(order);
    if (!customerPhone && order?.id) {
      const fresh = await prisma.pedido.findUnique({
        where: { id: order.id },
        select: {
          id: true,
          telefoneEntrega: true,
          usuario: { select: { telefone: true } },
        },
      });
      if (fresh) {
        customerPhone = getCustomerPhoneForDeliveredConfirmation(fresh);
      }
    }

    if (customerPhone) {
      console.log('\n📦 ENVIANDO CONFIRMAÇÃO DE ENTREGA (template deliveredConfirmation → cliente do pedido):');
      console.log(customerMessage);
      const result = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
      if (result.success) {
        console.log('✅ Confirmação de entrega enviada com sucesso!');
      } else {
        console.log('❌ Falha ao enviar confirmação de entrega');
      }
      return {
        success: result.success,
        customerMessage,
        result
      };
    } else {
      console.log('⚠️ Telefone do cliente não disponível para confirmação de entrega');
      return {
        success: false,
        error: 'Telefone do cliente não disponível'
      };
    }
  } catch (error) {
    console.error('❌ Erro ao enviar confirmação de entrega:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Serviço para notificação de pedido pronto para retirada
const sendPickupNotification = async (order) => {
  try {
    console.log('🏪 [MessageService] Enviando notificação de retirada');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      totalPrice: order.totalPrice,
      user: order.user?.username,
      deliveryType: order.deliveryType
    });

    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    const { enderecoPartes, pontoRefLoja, estimativaEntrega, storeName } = await getStorePickupDetails(order?.lojaId);
    // Verificar se precisa de troco
    const trocoLine =
      order.precisaTroco && order.valorTroco
        ? `\n💰 *Troco para:* R$ ${parseFloat(order.valorTroco).toFixed(2)}`
        : '';
    const paymentStatusLine =
      order.paymentMethod === 'CASH_ON_DELIVERY' ? 'Pagamento na retirada' : 'Pedido já pago';
    const enderecoLine = enderecoPartes ? `\n📍 *Endereço:* ${enderecoPartes}` : '';
    const referenciaLine = pontoRefLoja ? `\n📌 *Referência:* ${pontoRefLoja}` : '';

    const templates = await getWhatsappTemplates(order?.lojaId);
    const customerMessage = interpolateTemplate(templates.pickupReady, {
      dailyNumber: String(order.dailyNumber || order.id),
      storeName,
      enderecoLine,
      referenciaLine,
      totalPrice: parseFloat(order.totalPrice || 0).toFixed(2),
      trocoLine,
      itemsList: itemsListText,
      paymentStatusLine,
    });

    console.log('📱 Enviando notificação de retirada via Z-API...');
    
    // Enviar mensagem para o cliente
    const customerPhone = getPreferredCustomerPhone(order);
    if (customerPhone) {
      console.log('\n🏪 ENVIANDO NOTIFICAÇÃO DE RETIRADA:');
      console.log(customerMessage);
      const result = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
      
      if (result.success) {
        console.log('✅ Notificação de retirada enviada com sucesso!');
      } else {
        console.log('❌ Falha ao enviar notificação de retirada');
      }

      return {
        success: result.success,
        customerMessage,
        result
      };
    } else {
      console.log('⚠️ Telefone do cliente não disponível para notificação de retirada');
      return {
        success: false,
        error: 'Telefone do cliente não disponível'
      };
    }

  } catch (error) {
    console.error('❌ Erro ao enviar notificação de retirada:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

const sendDeliveryNotifications = async (order, deliverer) => {
  try {
    const templates = await getWhatsappTemplates(order?.lojaId);
    console.log('📱 [MessageService] Iniciando envio de notificações');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      totalPrice: order.totalPrice,
      user: order.user?.username,
      deliverer: deliverer?.nome,
      itemsCount: order.orderItems?.length
    });
 
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
 
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
 
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;
 
    const addressParts = [
      order.shippingStreet,
      order.shippingNumber,
      order.shippingComplement,
      order.shippingNeighborhood
    ].filter(Boolean);
 
    if (order.shippingReference) {
      addressParts.push(`Ref: ${order.shippingReference}`);
    }
 
    const address = addressParts.join(', ');
 
    const trocoInfo = order.precisaTroco && order.valorTroco
      ? `\n💰 *Troco para:* R$ ${parseFloat(order.valorTroco).toFixed(2)}`
      : '';
 
    const paymentMethod = order.pagamento?.metodo || order.metodoPagamento || order.paymentMethod || '';
    let paymentInfo = '';
    if (paymentMethod === 'PIX') {
      paymentInfo = templates.paymentLabelPix;
    } else if (paymentMethod === 'CREDIT_CARD') {
      paymentInfo = templates.paymentLabelCreditCard;
    } else if (paymentMethod === 'CASH_ON_DELIVERY') {
      paymentInfo = templates.paymentLabelCash;
    } else if (paymentMethod) {
      paymentInfo = interpolateTemplate(templates.paymentLabelFallback, { method: paymentMethod });
    }
 
    // Determinar nome do cliente (priorizar nomeClienteAvulso para pedidos de balcão)
    const clienteNome = order.nomeClienteAvulso || order.user?.username || order.usuario?.nomeUsuario || 'N/A';
    
    // Verificar se é pedido de balcão (tem nomeClienteAvulso)
    const isBalcaoOrder = !!(order.nomeClienteAvulso);
    
    // Telefone só aparece se NÃO for pedido de balcão
    const telefoneLine = isBalcaoOrder 
      ? '' 
      : ` *Telefone:* ${order.user?.phone || order.shippingPhone || order.telefoneEntrega || 'N/A'}`;

    const paymentInfoBlock = paymentInfo ? `\n${paymentInfo}` : '';

    const delivererMessage = interpolateTemplate(templates.deliveryToDeliverer, {
      dailyNumber: String(order.dailyNumber || order.id),
      clienteNome,
      telefoneLine,
      address: address || 'Endereço não informado',
      itemsList: itemsListText,
      totalPrice: parseFloat(order.totalPrice || 0).toFixed(2),
      trocoLine: trocoInfo,
      paymentInfoBlock,
    });

    const trocoInfoCliente = order.precisaTroco && order.valorTroco
      ? `\n💰 *Troco para:* R$ ${parseFloat(order.valorTroco).toFixed(2)}`
      : '';

    const customerMessage = interpolateTemplate(templates.deliveryToCustomer, {
      dailyNumber: String(order.dailyNumber || order.id),
      delivererName: deliverer?.nome || 'N/A',
      delivererPhone: deliverer?.telefone || 'N/A',
      address: address || 'Endereço não informado',
      totalPrice: parseFloat(order.totalPrice || 0).toFixed(2),
      trocoCliente: trocoInfoCliente,
      footerThanks: templates.deliveryFooterThanks,
    });
 
    const results = {
      deliverer: { success: false },
      customer: { success: false }
    };
 
    if (deliverer?.telefone) {
      const buttonId = `mark_delivered_order_${order.id}`;
      const delivererMessageWithAction =
        `${delivererMessage}\n\nAo finalizar a entrega, toque no botao abaixo para confirmar.`;
      const delivererButtonResult = await sendWhatsAppButtonListZApi(
        deliverer.telefone,
        delivererMessageWithAction,
        [{ id: buttonId, label: 'Marcar como entregue' }],
        order?.lojaId
      );

      if (delivererButtonResult.success) {
        results.deliverer = delivererButtonResult;
      } else {
        results.deliverer = await sendWhatsAppMessageZApi(
          deliverer.telefone,
          `${delivererMessage}\n\nPara confirmar a entrega: responda "Entregue #${order.id}".`,
          order?.lojaId
        );
      }
    }
 
    const customerPhone = getPreferredCustomerPhone(order);
    if (customerPhone) {
      results.customer = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
    }
 
    return {
      success: results.deliverer.success || results.customer.success,
      delivererMessage,
      customerMessage,
      results
    };
 
   } catch (error) {
     console.error('❌ Erro ao enviar notificações:', error);
     return {
       success: false,
       error: error.message
     };
   }
 };

// Serviço para notificação de pagamento confirmado (PIX)
const sendPaymentConfirmationNotification = async (order) => {
  try {
    console.log('💳 [MessageService] Enviando notificação de pagamento confirmado');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      precoTotal: order.precoTotal,
      usuario: order.usuario?.nomeUsuario,
      tipoEntrega: order.tipoEntrega
    });

    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    // Verificar se precisa de troco
    const trocoInfo = order.precisaTroco && order.valorTroco 
      ? `\n💰 *Troco para:* R$ ${parseFloat(order.valorTroco).toFixed(2)}`
      : '';

    const { storeName, enderecoPartes, pontoRefLoja, estimativaEntrega } = await getStorePickupDetails(order?.lojaId);

    const pickupInfo = `🏪 *Retirar em:* ${storeName}${estimativaEntrega ? `\n⏱️ *Estimativa:* ${estimativaEntrega}` : ''}\n*Aguarde a notificação para retirada*`;
    const dineInInfo = `🍽️ *Consumo no local*\n🏪 *Local:* ${storeName}${order.identificadorMesaSenha ? `\n🪑 *Mesa:* ${order.identificadorMesaSenha}` : ''}${estimativaEntrega ? `\n⏱️ *Estimativa:* ${estimativaEntrega}` : ''}`;

    const deliveryDetails =
      order.tipoEntrega === 'delivery'
        ? `*Será entregue em:* ${order.ruaEntrega}, ${order.numeroEntrega}${order.complementoEntrega ? ` - ${order.complementoEntrega}` : ''} - ${order.bairroEntrega}${order.referenciaEntrega ? `\n*Referência:* ${order.referenciaEntrega}` : ''}`
        : order.tipoEntrega === 'dine_in'
          ? dineInInfo
          : pickupInfo;

    const templates = await getWhatsappTemplates(order?.lojaId);
    const customerMessage = interpolateTemplate(templates.paymentConfirmed, {
      dailyNumber: String(order.dailyNumber || order.id),
      totalPrice: parseFloat(order.precoTotal || 0).toFixed(2),
      trocoInfo,
      itemsList: itemsListText,
      tipoEntregaDetails: deliveryDetails,
    });

    console.log('📱 Enviando notificação de pagamento confirmado via Z-API...');
    // Buscar telefone do usuário (preferencial) ou telefone de entrega
    const customerPhone = getPreferredCustomerPhone(order);
    if (customerPhone) {
      console.log('\n💳 ENVIANDO NOTIFICAÇÃO DE PAGAMENTO CONFIRMADO:');
      console.log(customerMessage);
      const result = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
      
      if (result.success) {
        console.log('✅ Notificação de pagamento confirmado enviada com sucesso!');
      } else {
        console.log('❌ Falha ao enviar notificação de pagamento confirmado');
      }

      return {
        success: result.success,
        customerMessage,
        result
      };
    } else {
      console.log('⚠️ Telefone do cliente não disponível para notificação de pagamento');
      return {
        success: false,
        error: 'Telefone do cliente não disponível'
      };
    }

  } catch (error) {
    console.error('❌ Erro ao enviar notificação de pagamento confirmado:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Serviço para notificação de pedido em preparo para cozinheiro
// Envia mensagem para todos os cozinheiros ativos da loja
const sendCookNotification = async (order, cook = null) => {
  try {
    console.log('👨‍🍳 [MessageService] Enviando notificação para cozinheiros');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      totalPrice: order.totalPrice,
      itemsCount: order.itens_pedido?.length
    });

    // Buscar todos os cozinheiros ativos da loja
    const lojaId = order?.lojaId;
    if (!lojaId) {
      console.log('⚠️ LojaId não disponível para buscar cozinheiros');
      return {
        success: false,
        error: 'LojaId não disponível',
        results: []
      };
    }

    const cozinheiros = await prisma.cozinheiro.findMany({
      where: {
        lojaId: lojaId,
        ativo: true
      }
    });

    if (cozinheiros.length === 0) {
      console.log('⚠️ Nenhum cozinheiro ativo encontrado para a loja');
      return {
        success: false,
        error: 'Nenhum cozinheiro ativo encontrado',
        results: []
      };
    }

    console.log(`👨‍🍳 [MessageService] Encontrados ${cozinheiros.length} cozinheiro(s) ativo(s)`);

    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    // Verificar se precisa de troco
    const trocoInfo = order.precisaTroco && order.valorTroco 
      ? `\n💰 *Troco para:* R$ ${parseFloat(order.valorTroco).toFixed(2)}`
      : '';

    const { storeName, enderecoPartes, pontoRefLoja, estimativaEntrega } = await getStorePickupDetails(order?.lojaId);

    const pickupLine = `🏪 RETIRADA NO LOCAL\n🏪 *Local:* ${storeName}${estimativaEntrega ? `\n⏱️ *Estimativa:* ${estimativaEntrega}` : ''}`;

    // Determinar nome do cliente (priorizar nomeClienteAvulso para pedidos de balcão)
    const clienteNome = order.nomeClienteAvulso || order.usuario?.nomeUsuario || order.user?.username || 'N/A';

    const tipoEntregaLine =
      order.tipoEntrega === 'delivery'
        ? '🚚 ENTREGA'
        : order.tipoEntrega === 'dine_in'
          ? '🍽️ CONSUMO NO LOCAL'
          : pickupLine;

    const observacoesBlock = order.observacoes
      ? ` *OBSERVAÇÕES DO CLIENTE:*\n${order.observacoes}\n`
      : '';

    const templates = await getWhatsappTemplates(order?.lojaId);
    const cookMessage = interpolateTemplate(templates.cookNewOrder, {
      dailyNumber: String(order.dailyNumber || order.id),
      clienteNome,
      tipoEntregaLine,
      totalPrice: parseFloat(order.precoTotal || 0).toFixed(2),
      trocoInfo,
      itemsList: itemsListText,
      observacoesBlock,
    });

    console.log('📱 Enviando notificação para cozinheiros via Z-API...');
    
    // Enviar mensagem para todos os cozinheiros ativos
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const cozinheiro of cozinheiros) {
      if (cozinheiro.telefone) {
        console.log(`\n👨‍🍳 ENVIANDO MENSAGEM PARA COZINHEIRO: ${cozinheiro.nome} (${cozinheiro.telefone})`);
        const result = await sendWhatsAppMessageZApi(cozinheiro.telefone, cookMessage, order?.lojaId);
        
        results.push({
          cozinheiroId: cozinheiro.id,
          cozinheiroNome: cozinheiro.nome,
          telefone: cozinheiro.telefone,
          success: result.success,
          error: result.error
        });

        if (result.success) {
          successCount++;
          console.log(`✅ Notificação enviada com sucesso para ${cozinheiro.nome}`);
        } else {
          failCount++;
          console.log(`❌ Falha ao enviar notificação para ${cozinheiro.nome}: ${result.error || 'Erro desconhecido'}`);
        }
      } else {
        failCount++;
        console.log(`⚠️ Telefone não disponível para cozinheiro ${cozinheiro.nome}`);
        results.push({
          cozinheiroId: cozinheiro.id,
          cozinheiroNome: cozinheiro.nome,
          telefone: null,
          success: false,
          error: 'Telefone não disponível'
        });
      }
    }

    const overallSuccess = successCount > 0;
    console.log(`\n📊 [MessageService] Resumo: ${successCount} sucesso(s), ${failCount} falha(s) de ${cozinheiros.length} cozinheiro(s)`);

    return {
      success: overallSuccess,
      cookMessage,
      totalCozinheiros: cozinheiros.length,
      successCount,
      failCount,
      results
    };

  } catch (error) {
    console.error('❌ Erro ao enviar notificação para cozinheiros:', error);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
};

// Serviço para notificação de cancelamento de pedido para o cliente
const sendOrderCancellationNotification = async (order, reason) => {
  try {
    console.log('❌ [MessageService] Enviando notificação de cancelamento ao cliente');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      precoTotal: order.precoTotal || order.totalPrice,
      usuario: order.usuario?.nomeUsuario || order.user?.username
    });

    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    const totalPrice = order.precoTotal || order.totalPrice || 0;
    
    // Verificar método de pagamento (pode estar em diferentes lugares)
    const paymentMethod = order.pagamento?.metodo || order.metodoPagamento || order.paymentMethod || '';

    const templates = await getWhatsappTemplates(order?.lojaId);
    const refundLine =
      paymentMethod === 'PIX' ? templates.orderCancelledRefundPix : templates.orderCancelledRefundOther;

    const customerMessage = interpolateTemplate(templates.orderCancelled, {
      dailyNumber: String(order.dailyNumber || order.id),
      totalPrice: parseFloat(totalPrice).toFixed(2),
      itemsList: itemsListText,
      refundLine,
      closingHelp: templates.orderCancelledClosing,
    });

    // Buscar telefone do usuário (preferencial) ou telefone de entrega
    const customerPhone = getPreferredCustomerPhone(order);
    if (customerPhone) {
      console.log('\n❌ ENVIANDO NOTIFICAÇÃO DE CANCELAMENTO:');
      console.log(customerMessage);
      const result = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
      if (result.success) {
        console.log('✅ Notificação de cancelamento enviada com sucesso!');
      } else {
        console.log('❌ Falha ao enviar notificação de cancelamento');
      }
      return {
        success: result.success,
        customerMessage,
        result
      };
    } else {
      console.log('⚠️ Telefone do cliente não disponível para notificação de cancelamento');
      return {
        success: false,
        error: 'Telefone do cliente não disponível'
      };
    }
  } catch (error) {
    console.error('❌ Erro ao enviar notificação de cancelamento:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Serviço para notificação de edição de pedido
const sendOrderEditNotification = async (order, oldTotal, newTotal, editReason) => {
  try {
    console.log('✏️ [MessageService] Enviando notificação de edição de pedido ao cliente');
    console.log('📋 [MessageService] Dados do pedido:', {
      id: order.id,
      oldTotal: oldTotal,
      newTotal: newTotal,
      usuario: order.usuario?.nomeUsuario || order.user?.username
    });

    // Buscar todos os sabores para mapear IDs para nomes
    const allFlavors = await prisma.sabor.findMany({ where: { ativo: true } });
    
    // Construir lista de itens com sabores e complementos
    const itemsList = order.itens_pedido?.length > 0
      ? await Promise.all(order.itens_pedido.map(item => formatOrderItem(item, allFlavors)))
      : ['Itens não disponíveis'];
    
    const itemsListText = Array.isArray(itemsList) ? itemsList.join('\n') : itemsList;

    const difference = parseFloat(newTotal) - parseFloat(oldTotal);
    const differenceText = difference > 0 
      ? `+R$ ${Math.abs(difference).toFixed(2)}` 
      : `-R$ ${Math.abs(difference).toFixed(2)}`;

    const editReasonBlock = editReason ? `*Motivo da alteração:*\n${editReason}\n` : '';

    const templates = await getWhatsappTemplates(order?.lojaId);
    const customerMessage = interpolateTemplate(templates.orderEdited, {
      dailyNumber: String(order.dailyNumber || order.id),
      oldTotal: parseFloat(oldTotal).toFixed(2),
      newTotal: parseFloat(newTotal).toFixed(2),
      differenceText,
      editReasonBlock,
      itemsList: itemsListText,
    });

    // Buscar telefone do usuário (preferencial) ou telefone de entrega
    const customerPhone = getPreferredCustomerPhone(order);
    if (customerPhone) {
      console.log('\n✏️ ENVIANDO NOTIFICAÇÃO DE EDIÇÃO DE PEDIDO:');
      console.log(customerMessage);
      const result = await sendWhatsAppMessageZApi(customerPhone, customerMessage, order?.lojaId);
      if (result.success) {
        console.log('✅ Notificação de edição de pedido enviada com sucesso!');
      } else {
        console.log('❌ Falha ao enviar notificação de edição de pedido');
      }
      return {
        success: result.success,
        customerMessage,
        result
      };
    } else {
      console.log('⚠️ Telefone do cliente não disponível para notificação de edição');
      return {
        success: false,
        error: 'Telefone do cliente não disponível'
      };
    }
  } catch (error) {
    console.error('❌ Erro ao enviar notificação de edição de pedido:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = {
  sendDeliveryNotifications,
  sendPickupNotification,
  sendPaymentConfirmationNotification,
  sendCookNotification,
  sendDeliveredConfirmationNotification,
  sendOrderCancellationNotification,
  sendOrderEditNotification,
  sendWhatsAppMessageZApi,
  sendWhatsAppButtonListZApi,
  sendWhatsAppOptionListZApi,
  checkPhoneExistsWhatsApp,
  getWhatsappTemplates,
  interpolateTemplate,
  startAutomaticDeliveryShiftNotifier,
};