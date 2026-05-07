const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

function sessionFile(userData) {
  return path.join(userData, 'session.json');
}

/**
 * @returns {{ apiHttpBase: string, lojaSubdominio: string, lojaId: number, lojaNome?: string, token: string } | null}
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

  let token = null;
  if (raw.tokenCipherKind === 'safeStorage' && raw.tokenCipher) {
    try {
      token = safeStorage.decryptString(Buffer.from(raw.tokenCipher, 'base64'));
    } catch {
      return null;
    }
  } else if (raw.tokenPlainInsecure) {
    token = raw.tokenPlainInsecure;
  }

  if (!token) return null;

  return {
    apiHttpBase: raw.apiHttpBase,
    lojaSubdominio: raw.lojaSubdominio || '',
    lojaId: Number(raw.lojaId),
    lojaNome: raw.lojaNome,
    token,
  };
}

function saveSession(userData, data) {
  const { token, ...meta } = data;
  const out = { ...meta, version: 1 };

  if (token && safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(token);
    out.tokenCipher = Buffer.from(enc).toString('base64');
    out.tokenCipherKind = 'safeStorage';
  } else if (token) {
    out.tokenPlainInsecure = token;
  }

  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(sessionFile(userData), JSON.stringify(out), 'utf8');
}

function clearSession(userData) {
  try {
    fs.unlinkSync(sessionFile(userData));
  } catch (_) {}
}

module.exports = { loadSession, saveSession, clearSession };
