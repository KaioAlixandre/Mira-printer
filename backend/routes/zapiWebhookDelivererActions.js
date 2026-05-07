const {
  sendWhatsAppMessageZApi,
  sendDeliveredConfirmationNotification,
} = require('../services/messageService');

const MARK_DELIVERED_BUTTON_PREFIX = 'mark_delivered_order_';

function normalizeText(input) {
  return (input || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizePhoneForComparison(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits.slice(2);
  return digits;
}

function phonesMatch(phoneA, phoneB) {
  const normalizedA = normalizePhoneForComparison(phoneA);
  const normalizedB = normalizePhoneForComparison(phoneB);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  return normalizedA.endsWith(normalizedB) || normalizedB.endsWith(normalizedA);
}

function parseDeliveredConfirmationIntent(text) {
  const raw = (text || '').toString().trim();
  if (!raw) return null;

  const normalizedRaw = normalizeText(raw);
  if (normalizedRaw === 'marcar como entregue') {
    return { mode: 'generic' };
  }

  if (normalizedRaw.startsWith(MARK_DELIVERED_BUTTON_PREFIX)) {
    const possibleId = Number(normalizedRaw.replace(MARK_DELIVERED_BUTTON_PREFIX, ''));
    if (Number.isInteger(possibleId) && possibleId > 0) {
      return { mode: 'db_id', orderDbId: possibleId };
    }
  }

  const fallbackMatch = raw.match(/(?:marcar como entregue|entregue)\s*#?\s*(\d+)/i);
  if (!fallbackMatch) return null;
  const n = Number(fallbackMatch[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  /** Texto livre: #N é o número do painel (sequência do dia), não o id interno do banco. */
  return { mode: 'panel_number', panelNumber: n };
}

function getBrazilDayKey(date) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

async function getOrderDisplayNumber(prisma, order) {
  try {
    const dayKey = getBrazilDayKey(new Date(order.criadoEm));
    const dayStart = new Date(`${dayKey}T00:00:00-03:00`);
    const dayEnd = new Date(`${dayKey}T23:59:59-03:00`);
    const count = await prisma.pedido.count({
      where: {
        lojaId: order.lojaId,
        criadoEm: { gte: dayStart, lte: dayEnd },
        id: { lte: order.id },
      },
    });
    return count || order.id;
  } catch {
    return order.id;
  }
}

function buildOrderLabel(orderDisplayNumber) {
  return `Pedido #${orderDisplayNumber}`;
}

function getNowInSaoPaulo() {
  const brasilNowString = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  return new Date(brasilNowString);
}

/**
 * Número exibido no painel (#1, #2…): mesma regra do admin — pedidos do dia (SP) ordenados por criação.
 * Retorna o pedido na posição `panelNumber` (1-based) ou null.
 */
async function findOrderByStorePanelNumberToday(prisma, lojaId, panelNumber) {
  if (!Number.isInteger(panelNumber) || panelNumber < 1) return null;
  const dayKey = getBrazilDayKey(getNowInSaoPaulo());
  const dayStart = new Date(`${dayKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${dayKey}T23:59:59-03:00`);
  const list = await prisma.pedido.findMany({
    where: {
      lojaId,
      criadoEm: { gte: dayStart, lte: dayEnd },
    },
    orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      lojaId: true,
      criadoEm: true,
      status: true,
      entregadorId: true,
    },
  });
  if (panelNumber > list.length) return null;
  return list[panelNumber - 1];
}

async function resolveOrderByPanelNumberOrRouteId(
  prisma,
  lojaId,
  delivererId,
  panelNumber,
  orderInclude
) {
  const byIdOnRoute = await prisma.pedido.findFirst({
    where: {
      id: panelNumber,
      lojaId,
      status: 'on_the_way',
      entregadorId: delivererId,
    },
    include: orderInclude,
  });
  if (byIdOnRoute) return byIdOnRoute;

  const head = await findOrderByStorePanelNumberToday(prisma, lojaId, panelNumber);
  if (
    head
    && head.status === 'on_the_way'
    && head.entregadorId === delivererId
  ) {
    return prisma.pedido.findFirst({
      where: { id: head.id, lojaId },
      include: orderInclude,
    });
  }
  return null;
}


async function handleDelivererDeliveredAction({ prisma, text, phone, lojaId }) {
  const deliveredIntent = parseDeliveredConfirmationIntent(text);
  if (!deliveredIntent) return false;

  const orderInclude = {
    entregador: {
      select: {
        id: true,
        nome: true,
        telefone: true,
        ativo: true,
      },
    },
    usuario: {
      select: {
        id: true,
        nomeUsuario: true,
        telefone: true,
      },
    },
    itens_pedido: {
      include: {
        produto: true,
        complementos: {
          include: {
            complemento: true,
          },
        },
      },
    },
  };

  const deliverers = await prisma.entregador.findMany({
    where: { lojaId, ativo: true },
    select: { id: true, telefone: true },
  });
  const delivererFromPhone = deliverers.find((d) => phonesMatch(phone, d.telefone));

  let order = null;

  if (deliveredIntent.mode === 'generic') {
    if (!delivererFromPhone) {
      await sendWhatsAppMessageZApi(
        phone,
        'Nao consegui identificar seu cadastro de entregador nesta loja para confirmar a entrega.',
        lojaId
      );
      return true;
    }

    const onTheWayOrders = await prisma.pedido.findMany({
      where: {
        lojaId,
        status: 'on_the_way',
        entregadorId: delivererFromPhone.id,
      },
      include: orderInclude,
      orderBy: [{ saiuParaEntregaEm: 'desc' }, { atualizadoEm: 'desc' }, { id: 'desc' }],
      take: 2,
    });

    if (!onTheWayOrders.length) {
      await sendWhatsAppMessageZApi(
        phone,
        'Voce nao possui pedido em rota no momento para marcar como entregue.',
        lojaId
      );
      return true;
    }

    if (onTheWayOrders.length > 1) {
      await sendWhatsAppMessageZApi(
        phone,
        'Voce possui mais de um pedido em rota. Responda: Entregue #NUMERO (o mesmo numero do painel do dia, ex.: Pedido #6).',
        lojaId
      );
      return true;
    }

    order = onTheWayOrders[0];
  } else if (deliveredIntent.mode === 'db_id') {
    order = await prisma.pedido.findFirst({
      where: { id: deliveredIntent.orderDbId, lojaId },
      include: orderInclude,
    });
    if (!order) {
      await sendWhatsAppMessageZApi(
        phone,
        `Nao encontrei o pedido interno #${deliveredIntent.orderDbId} nesta loja.`,
        lojaId
      );
      return true;
    }
  } else if (deliveredIntent.mode === 'panel_number') {
    if (!delivererFromPhone) {
      await sendWhatsAppMessageZApi(
        phone,
        'Nao consegui identificar seu cadastro de entregador nesta loja para confirmar a entrega.',
        lojaId
      );
      return true;
    }
    order = await resolveOrderByPanelNumberOrRouteId(
      prisma,
      lojaId,
      delivererFromPhone.id,
      deliveredIntent.panelNumber,
      orderInclude
    );
    if (!order) {
      await sendWhatsAppMessageZApi(
        phone,
        `Nao encontrei o pedido #${deliveredIntent.panelNumber} em rota para voce hoje. Envie o mesmo numero do painel (ex.: Entregue #6) ou use o botao na mensagem da entrega.`,
        lojaId
      );
      return true;
    }
  }

  if (!order) {
    await sendWhatsAppMessageZApi(phone, 'Nao foi possivel localizar o pedido para confirmar entrega.', lojaId);
    return true;
  }

  const orderDisplayNumber = await getOrderDisplayNumber(prisma, order);
  const orderLabel = buildOrderLabel(orderDisplayNumber);

  if (!order.entregadorId || !order.entregador) {
    await sendWhatsAppMessageZApi(phone, `O ${orderLabel} nao possui entregador vinculado no momento.`, lojaId);
    return true;
  }

  if (!order.entregador.ativo) {
    await sendWhatsAppMessageZApi(
      phone,
      `O entregador vinculado ao ${orderLabel} esta inativo e nao pode confirmar a entrega.`,
      lojaId
    );
    return true;
  }

  if (!phonesMatch(phone, order.entregador.telefone)) {
    await sendWhatsAppMessageZApi(phone, `Voce nao esta autorizado a marcar o ${orderLabel} como entregue.`, lojaId);
    return true;
  }

  if (order.status === 'delivered') {
    await sendWhatsAppMessageZApi(phone, `O ${orderLabel} ja estava marcado como entregue.`, lojaId);
    return true;
  }

  if (order.status !== 'on_the_way') {
    await sendWhatsAppMessageZApi(
      phone,
      `O ${orderLabel} esta com status "${order.status}" e nao pode ser finalizado por aqui.`,
      lojaId
    );
    return true;
  }

  const updatedOrder = await prisma.pedido.update({
    where: { id: order.id },
    data: { status: 'delivered' },
    include: {
      usuario: {
        select: {
          id: true,
          nomeUsuario: true,
          telefone: true,
        },
      },
      itens_pedido: {
        include: {
          produto: true,
          complementos: {
            include: {
              complemento: true,
            },
          },
        },
      },
    },
  });
  updatedOrder.dailyNumber = orderDisplayNumber;

  try {
    await sendDeliveredConfirmationNotification(updatedOrder);
  } catch (notifyError) {
    console.error('❌ [Z-API Webhook] Erro ao notificar cliente sobre entrega:', notifyError.message);
  }

  await sendWhatsAppMessageZApi(phone, `${orderLabel} marcado como entregue com sucesso.`, lojaId);
  console.log(`✅ [Z-API Webhook] ${orderLabel} marcado como entregue pelo entregador ${order.entregador.nome}`);
  return true;
}

module.exports = {
  handleDelivererDeliveredAction,
};
