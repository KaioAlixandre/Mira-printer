const Stripe = require('stripe');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  // Mantem o processo vivo, mas falha explicitamente ao usar as rotas.
  console.warn('[Stripe] STRIPE_SECRET_KEY nao configurada.');
}

const stripe = new Stripe(stripeSecretKey || 'sk_test_missing_key', {
  apiVersion: '2026-01-28.clover',
});

const PLAN_PRICE_ENV_BY_ID = {
  simples: 'STRIPE_PRICE_SIMPLES',
  pro: 'STRIPE_PRICE_PRO',
  plus: 'STRIPE_PRICE_PLUS',
};

function getPriceIdByPlan(planId) {
  const envName = PLAN_PRICE_ENV_BY_ID[planId];
  if (!envName) return null;
  return process.env[envName] || null;
}

function getPlanIdByPriceId(priceId) {
  const entries = Object.entries(PLAN_PRICE_ENV_BY_ID);
  for (const [planId, envName] of entries) {
    if (process.env[envName] && process.env[envName] === priceId) {
      return planId;
    }
  }
  return null;
}

module.exports = {
  stripe,
  getPriceIdByPlan,
  getPlanIdByPriceId,
};
