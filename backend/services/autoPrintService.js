const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function resolveCommand() {
  return process.env.AUTO_PRINT_PREPARING_COMMAND || 'node scripts/auto_print_preparing_orders.js';
}

function normalizeLojaId(lojaId) {
  const parsed = Number(lojaId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getStoreScopedEnv(keyBase, lojaId) {
  const normalizedId = normalizeLojaId(lojaId);
  if (!normalizedId) return null;
  const key = `${keyBase}_LOJA_${normalizedId}`;
  return process.env[key] ?? null;
}

function resolveEnabledFromEnv(lojaId) {
  const scoped = getStoreScopedEnv('AUTO_PRINT_PREPARING_ENABLED', lojaId);
  if (scoped !== null) return isEnabled(scoped);
  return isEnabled(process.env.AUTO_PRINT_PREPARING_ENABLED);
}

function resolveCommandByStoreFromEnv(lojaId) {
  const scoped = getStoreScopedEnv('AUTO_PRINT_PREPARING_COMMAND', lojaId);
  if (scoped && String(scoped).trim()) return String(scoped).trim();
  return resolveCommand();
}

function buildOrderPayload(order = {}) {
  return {
    ...order,
    observacoes: order.observacoes || null,
    dailyNumber: order.dailyNumber || null
  };
}

async function resolveStoreConfig(lojaId) {
  const normalizedId = normalizeLojaId(lojaId);
  if (!normalizedId) return null;
  try {
    return await prisma.configuracao_loja.findUnique({
      where: { lojaId: normalizedId },
      select: {
        autoPrintPreparingEnabled: true,
        autoPrintPreparingCommand: true,
        autoPrintPrinterType: true,
        autoPrintPrinterTarget: true,
        autoPrintPaperWidthMm: true
      }
    });
  } catch {
    return null;
  }
}

async function triggerAutoPrint(order, reason = 'status_changed_to_being_prepared') {
  const lojaId = order?.lojaId;
  const storeConfig = await resolveStoreConfig(lojaId);
  const enabled =
    typeof storeConfig?.autoPrintPreparingEnabled === 'boolean'
      ? storeConfig.autoPrintPreparingEnabled
      : resolveEnabledFromEnv(lojaId);

  if (!enabled) {
    return;
  }

  const command = String(storeConfig?.autoPrintPreparingCommand || '').trim() || resolveCommandByStoreFromEnv(lojaId);
  const payload = buildOrderPayload(order);
  payload.__autoPrintConfig = {
    printerType: storeConfig?.autoPrintPrinterType || null,
    printerTarget: storeConfig?.autoPrintPrinterTarget || null,
    paperWidthMm: storeConfig?.autoPrintPaperWidthMm || null
  };
  const payloadString = JSON.stringify(payload);

  const child = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      AUTO_PRINT_REASON: reason,
      AUTO_PRINT_ORDER_ID: String(payload.id || ''),
      AUTO_PRINT_LOJA_ID: String(payload.lojaId || ''),
      AUTO_PRINT_ORDER_JSON: payloadString,
      AUTO_PRINT_PREPARING_EFFECTIVE_COMMAND: command
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    const output = String(chunk || '').trim();
    if (output) {
      console.log(`[AutoPrint] ${output}`);
    }
  });

  child.stderr.on('data', (chunk) => {
    const output = String(chunk || '').trim();
    if (output) {
      console.error(`[AutoPrint] ${output}`);
    }
  });

  child.on('error', (error) => {
    console.error('[AutoPrint] Falha ao iniciar processo de impressão automática:', error.message);
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[AutoPrint] Processo finalizado com código ${code}.`);
    }
  });
}

module.exports = {
  triggerAutoPrint
};
