const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Link mágico persistente por cliente (quase sem expiração prática)
const TTL_MS = Number(process.env.MAGIC_LINK_TTL_MS) || 100 * 365 * 24 * 60 * 60 * 1000;

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hashMagicToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function generateRawMagicToken() {
  return toBase64Url(crypto.randomBytes(24));
}

function generateShortCode(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

async function createUniqueShortCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateShortCode(10);
    const exists = await prisma.usuario_magic_link.findUnique({
      where: { shortCode: code },
      select: { id: true },
    });
    if (!exists) return code;
  }
  throw new Error('Não foi possível gerar shortCode único para magic link.');
}

/**
 * Mantém 1 link mágico estável por cliente.
 * Se já existir, retorna o mesmo token; caso contrário, cria um novo.
 */
async function createMagicLinkForCustomer(lojaId, usuarioId) {
  const existing = await prisma.usuario_magic_link.findUnique({
    where: {
      lojaId_usuarioId: { lojaId, usuarioId },
    },
    select: { id: true, tokenRaw: true, shortCode: true, expiresAt: true },
  });

  if (existing?.tokenRaw) {
    if (!existing.shortCode) {
      await prisma.usuario_magic_link.update({
        where: { id: existing.id },
        data: { shortCode: await createUniqueShortCode() },
      });
    }
    if (existing.expiresAt <= new Date()) {
      await prisma.usuario_magic_link.update({
        where: { id: existing.id },
        data: { expiresAt: new Date(Date.now() + TTL_MS) },
      });
    }
    return existing.tokenRaw;
  }

  const raw = generateRawMagicToken();
  const tokenHash = hashMagicToken(raw);
  const shortCode = await createUniqueShortCode();
  const expiresAt = new Date(Date.now() + TTL_MS);

  await prisma.usuario_magic_link.upsert({
    where: {
      lojaId_usuarioId: { lojaId, usuarioId },
    },
    update: {
      shortCode,
      tokenRaw: raw,
      tokenHash,
      expiresAt,
    },
    create: { lojaId, usuarioId, shortCode, tokenRaw: raw, tokenHash, expiresAt },
  });

  return raw;
}

/**
 * Monta a URL pública do login por link mágico para um usuário (gera novo token).
 */
async function getMagicLoginUrlForUsuario(lojaId, usuarioId) {
  const loja = await prisma.loja.findUnique({
    where: { id: lojaId },
    select: { subdominio: true },
  });
  if (!loja?.subdominio) return null;

  await createMagicLinkForCustomer(lojaId, usuarioId);
  const record = await prisma.usuario_magic_link.findUnique({
    where: { lojaId_usuarioId: { lojaId, usuarioId } },
    select: { shortCode: true, tokenRaw: true },
  });
  const slug = record?.shortCode || record?.tokenRaw;
  if (!slug) return null;
  const baseDomain = process.env.BASE_DOMAIN || 'miradelivery.com.br';
  const protocol = process.env.PROTOCOL || 'https';
  const base = `${protocol}://${loja.subdominio}.${baseDomain}`.replace(/\/+$/, '');
  return `${base}/m/${encodeURIComponent(slug)}`;
}

module.exports = {
  hashMagicToken,
  createMagicLinkForCustomer,
  getMagicLoginUrlForUsuario,
};
