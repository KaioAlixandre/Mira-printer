const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

function sessionFile(userData) {
  return path.join(userData, 'session.json');
}

function decryptField(raw, prefix) {
  const cipher = raw[`${prefix}Cipher`];
  if (raw[`${prefix}CipherKind`] === 'safeStorage' && cipher) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    } catch {
      return null;
    }
  }
  return raw[`${prefix}PlainInsecure`] || null;
}

function encryptField(out, prefix, value) {
  if (!value) return;
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(value);
    out[`${prefix}Cipher`] = Buffer.from(enc).toString('base64');
    out[`${prefix}CipherKind`] = 'safeStorage';
  } else {
    out[`${prefix}PlainInsecure`] = value;
  }
}

/**
 * @returns {{ apiHttpBase: string, lojaSubdominio: string, lojaId: number, lojaNome?: string, token: string, refreshToken: string | null } | null}
 */
function loadSession(userData) {
  const p = sessionFile(userData);
  if (!fs.existsSync(p)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }

  const token = decryptField(raw, 'token');
  if (!token) return null;

  return {
    apiHttpBase: raw.apiHttpBase,
    lojaSubdominio: raw.lojaSubdominio || '',
    lojaId: Number(raw.lojaId),
    lojaNome: raw.lojaNome,
    token,
    refreshToken: decryptField(raw, 'refreshToken'),
  };
}

function saveSession(userData, data) {
  const { token, refreshToken, ...meta } = data;
  const out = { ...meta, version: 2 };

  encryptField(out, 'token', token);
  encryptField(out, 'refreshToken', refreshToken);

  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(sessionFile(userData), JSON.stringify(out), 'utf8');
}

function clearSession(userData) {
  try {
    fs.unlinkSync(sessionFile(userData));
  } catch (_) {}
}

module.exports = { loadSession, saveSession, clearSession };
