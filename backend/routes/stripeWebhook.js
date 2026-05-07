const { PrismaClient } = require('@prisma/client');
const { stripe, getPlanIdByPriceId } = require('../services/stripe');

const prisma = new PrismaClient();

async function syncSubscription(subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) return;

  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const metadataPlanId = subscription?.metadata?.planId || null;
  const mappedPlanId = getPlanIdByPriceId(priceId) || null;
  const planId = (metadataPlanId && ['simples', 'pro', 'plus'].includes(metadataPlanId))
    ? metadataPlanId
    : mappedPlanId;

  const currentPeriodEndUnix = subscription.items?.data?.[0]?.current_period_end
    || subscription.current_period_end
    || null;

  const assinaturaRenovaEm = currentPeriodEndUnix
    ? new Date(currentPeriodEndUnix * 1000)
    : null;

  await prisma.loja.updateMany({
    where: { stripeCustomerId: customerId },
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      assinaturaStatus: subscription.status || 'inativa',
      assinaturaRenovaEm,
      ...(planId ? { planoMensal: planId } : {}),
    },
  });
}

async function clearSubscriptionByCustomer(customerId) {
  if (!customerId) return;
  await prisma.loja.updateMany({
    where: { stripeCustomerId: customerId },
    data: {
      stripeSubscriptionId: null,
      stripePriceId: null,
      assinaturaStatus: 'cancelada',
      assinaturaRenovaEm: null,
    },
  });
}

async function handleStripeWebhook(req, res) {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(400).send('STRIPE_WEBHOOK_SECRET nao configurado.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscription(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await syncSubscription(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;
        await clearSubscriptionByCustomer(customerId);
        break;
      }
      default:
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao processar webhook Stripe.', details: error.message });
  }
}

module.exports = {
  handleStripeWebhook,
};
