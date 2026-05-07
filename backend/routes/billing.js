const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authModule = require('./auth');
const { stripe, getPriceIdByPlan, getPlanIdByPriceId } = require('../services/stripe');

const router = express.Router();
const prisma = new PrismaClient();
const { authenticateToken, authorize } = authModule;

function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function toIsoOrNull(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function formatSubscriptionDetails(subscription) {
  const item = subscription?.items?.data?.[0];
  const price = item?.price;
  const recurring = price?.recurring;
  const paymentMethod = subscription?.default_payment_method;
  const metadataPlanId = subscription?.metadata?.planId || null;
  const mappedPlanId = getPlanIdByPriceId(price?.id || null);
  const planId = metadataPlanId || mappedPlanId || null;

  return {
    subscriptionId: subscription.id || null,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : (subscription.customer?.id || null),
    planId,
    status: subscription.status || null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: toIsoOrNull(subscription.cancel_at),
    currentPeriodStart: toIsoOrNull(item?.current_period_start || subscription.current_period_start),
    currentPeriodEnd: toIsoOrNull(item?.current_period_end || subscription.current_period_end),
    trialStart: toIsoOrNull(subscription.trial_start),
    trialEnd: toIsoOrNull(subscription.trial_end),
    collectionMethod: subscription.collection_method || null,
    price: {
      id: price?.id || null,
      unitAmount: typeof price?.unit_amount === 'number' ? price.unit_amount : null,
      currency: price?.currency || null,
      type: price?.type || null,
      recurring: recurring ? {
        interval: recurring.interval || null,
        intervalCount: recurring.interval_count || null,
      } : null,
      productId: typeof price?.product === 'string' ? price.product : (price?.product?.id || null),
    },
    defaultPaymentMethod: paymentMethod ? {
      id: paymentMethod.id || null,
      type: paymentMethod.type || null,
      card: paymentMethod.card ? {
        brand: paymentMethod.card.brand || null,
        last4: paymentMethod.card.last4 || null,
        expMonth: paymentMethod.card.exp_month || null,
        expYear: paymentMethod.card.exp_year || null,
      } : null,
    } : null,
  };
}

function pickBestSubscription(subscriptions = []) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;
  const priority = [
    'active',
    'trialing',
    'past_due',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'canceled',
  ];
  const ranked = [...subscriptions].sort((a, b) => {
    const pa = priority.indexOf(a.status);
    const pb = priority.indexOf(b.status);
    const ra = pa === -1 ? 999 : pa;
    const rb = pb === -1 ? 999 : pb;
    if (ra !== rb) return ra - rb;
    return (b.created || 0) - (a.created || 0);
  });
  return ranked[0];
}

router.get('/status', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const loja = await prisma.loja.findUnique({
      where: { id: req.lojaId },
      select: {
        planoMensal: true,
        assinaturaStatus: true,
        assinaturaRenovaEm: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });

    if (!loja) {
      return res.status(404).json({ message: 'Loja nao encontrada.' });
    }

    let stripeSubscription = null;
    let stripeSyncError = null;
    if (isStripeConfigured() && loja.stripeCustomerId) {
      try {
        if (loja.stripeSubscriptionId) {
          stripeSubscription = await stripe.subscriptions.retrieve(loja.stripeSubscriptionId, {
            expand: ['default_payment_method', 'items.data.price.product'],
          });
        }

        // Fallback: caso a coluna local esteja vazia ou apontando para assinatura removida,
        // busca diretamente no customer Stripe e escolhe a mais relevante.
        if (!stripeSubscription) {
          const subscriptionList = await stripe.subscriptions.list({
            customer: loja.stripeCustomerId,
            status: 'all',
            limit: 20,
            expand: ['data.default_payment_method'],
          });
          stripeSubscription = pickBestSubscription(subscriptionList.data);
        }
      } catch (err) {
        // Se a assinatura armazenada localmente nao existir mais, tenta listar pelo customer.
        try {
          const subscriptionList = await stripe.subscriptions.list({
            customer: loja.stripeCustomerId,
            status: 'all',
            limit: 20,
            expand: ['data.default_payment_method'],
          });
          stripeSubscription = pickBestSubscription(subscriptionList.data);
        } catch (fallbackErr) {
          stripeSyncError = fallbackErr.message || err.message;
        }
      }
    }

    const details = stripeSubscription ? formatSubscriptionDetails(stripeSubscription) : null;

    let planoMensalSincronizado = loja.planoMensal;

    // Sincroniza colunas locais sempre que encontrar assinatura no Stripe.
    if (details) {
      const planIdToPersist = (details.planId && ['simples', 'pro', 'plus'].includes(details.planId))
        ? details.planId
        : null;
      await prisma.loja.update({
        where: { id: req.lojaId },
        data: {
          stripeSubscriptionId: details.subscriptionId,
          stripePriceId: details.price?.id || null,
          assinaturaStatus: details.status || null,
          assinaturaRenovaEm: details.currentPeriodEnd ? new Date(details.currentPeriodEnd) : null,
          ...(planIdToPersist ? { planoMensal: planIdToPersist } : {}),
        },
      });
      if (planIdToPersist) {
        planoMensalSincronizado = planIdToPersist;
      }
    }

    return res.json({
      planoMensal: planoMensalSincronizado,
      assinaturaStatus: (details?.status || loja.assinaturaStatus || 'inativa'),
      assinaturaRenovaEm: (details?.currentPeriodEnd || loja.assinaturaRenovaEm),
      possuiAssinatura: Boolean(loja.stripeSubscriptionId),
      stripeConfigurado: isStripeConfigured(),
      portalDisponivel: Boolean(loja.stripeCustomerId),
      assinatura: details,
      stripeSyncError,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao buscar status da assinatura.', details: error.message });
  }
});

router.post('/checkout-session', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(400).json({ message: 'Stripe nao configurado no backend.' });
    }

    const { planId, successUrl, cancelUrl } = req.body || {};
    if (!['simples', 'pro', 'plus'].includes(planId)) {
      return res.status(400).json({ message: 'Plano invalido.' });
    }
    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ message: 'successUrl e cancelUrl sao obrigatorias.' });
    }

    const priceId = getPriceIdByPlan(planId);
    if (!priceId) {
      return res.status(400).json({ message: `Price do plano '${planId}' nao configurado.` });
    }

    const loja = await prisma.loja.findUnique({
      where: { id: req.lojaId },
      select: {
        id: true,
        nome: true,
        subdominio: true,
        stripeCustomerId: true,
      },
    });

    if (!loja) {
      return res.status(404).json({ message: 'Loja nao encontrada.' });
    }

    let customerId = loja.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: loja.nome,
        metadata: {
          lojaId: String(loja.id),
          subdominio: loja.subdominio,
        },
      });
      customerId = customer.id;
      await prisma.loja.update({
        where: { id: loja.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      client_reference_id: String(loja.id),
      metadata: {
        lojaId: String(loja.id),
        planId,
      },
      subscription_data: {
        metadata: {
          lojaId: String(loja.id),
          planId,
        },
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao criar checkout de assinatura.', details: error.message });
  }
});

router.post('/portal-session', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(400).json({ message: 'Stripe nao configurado no backend.' });
    }

    const { returnUrl } = req.body || {};
    if (!returnUrl) {
      return res.status(400).json({ message: 'returnUrl e obrigatoria.' });
    }

    const loja = await prisma.loja.findUnique({
      where: { id: req.lojaId },
      select: { stripeCustomerId: true },
    });

    if (!loja || !loja.stripeCustomerId) {
      return res.status(400).json({ message: 'Cliente Stripe nao encontrado para esta loja.' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: loja.stripeCustomerId,
      return_url: returnUrl,
    });

    return res.json({ url: portalSession.url });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao abrir portal de faturamento.', details: error.message });
  }
});

router.get('/invoices', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(400).json({ message: 'Stripe nao configurado no backend.' });
    }

    const loja = await prisma.loja.findUnique({
      where: { id: req.lojaId },
      select: { stripeCustomerId: true },
    });

    if (!loja || !loja.stripeCustomerId) {
      return res.json({ invoices: [] });
    }

    const invoices = await stripe.invoices.list({
      customer: loja.stripeCustomerId,
      limit: 20,
    });

    const items = (invoices.data || []).map((inv) => ({
      id: inv.id,
      number: inv.number || inv.id,
      status: inv.status || 'unknown',
      amountPaid: typeof inv.amount_paid === 'number' ? inv.amount_paid : 0,
      amountDue: typeof inv.amount_due === 'number' ? inv.amount_due : 0,
      currency: inv.currency || 'brl',
      createdAt: toIsoOrNull(inv.created),
      paidAt: inv.status_transitions?.paid_at ? toIsoOrNull(inv.status_transitions.paid_at) : null,
      hostedInvoiceUrl: inv.hosted_invoice_url || null,
      invoicePdf: inv.invoice_pdf || null,
    }));

    return res.json({ invoices: items });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao listar historico de pagamentos.', details: error.message });
  }
});

module.exports = router;
