/**
 * Backfill: garante link mágico estável para cada cliente já cadastrado.
 * Com o modelo atual, também preenche campos faltantes como tokenRaw/shortCode
 * em registros antigos.
 *
 * Uso:
 *   node scripts/backfill-magic-links.js
 *   node scripts/backfill-magic-links.js --dry-run
 *
 * Carrega variáveis de backend/.env (via dotenv a partir da pasta backend).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { createMagicLinkForCustomer } = require('../services/magicLinkService');

const prisma = new PrismaClient();

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const customers = await prisma.usuario.findMany({
    where: { funcao: 'user' },
    select: { id: true, lojaId: true, nomeUsuario: true, telefone: true },
    orderBy: { id: 'asc' },
  });

  let processed = 0;

  for (const u of customers) {
    if (dryRun) {
      processed += 1;
      continue;
    }

    await createMagicLinkForCustomer(u.lojaId, u.id);
    processed += 1;
  }

  console.log(
    `[backfill-magic-links] clientes (funcao=user): ${customers.length} | ` +
      `processados: ${processed}` +
      (dryRun ? ' (dry-run)' : '')
  );

  if (dryRun) {
    console.log('[backfill-magic-links] Nenhuma alteração no banco (--dry-run).');
  }
}

main()
  .catch((e) => {
    console.error('[backfill-magic-links] Erro:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
