const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { autoUpdater } = require('electron-updater');
const { loadSession, saveSession, clearSession } = require('./auth-session.cjs');

function loadDevEnv() {
  try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
  } catch (_) {}
}

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getPrintSettingsPath() {
  return path.join(app.getPath('userData'), 'print-settings.json');
}

function loadPrintSettings() {
  const raw = readJsonSafe(getPrintSettingsPath());
  if (!raw || typeof raw !== 'object') {
    return {
      printerType: '',
      printerTarget: '',
      paperWidthMm: 80,
      fontScale: 'normal',
    };
  }
  return {
    printerType: String(raw.printerType || ''),
    printerTarget: String(raw.printerTarget || ''),
    paperWidthMm: Number(raw.paperWidthMm || 80),
    fontScale: String(raw.fontScale || 'normal'),
  };
}

function savePrintSettings(settings) {
  const next = {
    printerType: String(settings?.printerType || ''),
    printerTarget: String(settings?.printerTarget || ''),
    paperWidthMm: Number(settings?.paperWidthMm || 80),
    fontScale: String(settings?.fontScale || 'normal'),
  };
  fs.writeFileSync(getPrintSettingsPath(), JSON.stringify(next), 'utf8');
  return next;
}

function listWindowsPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve([]);
      return;
    }
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    ps.stdout.on('data', (d) => (out += String(d || '')));
    ps.on('error', () => resolve([]));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
      } catch {
        resolve([]);
      }
    });
  });
}

function normalizeApiBase(u) {
  if (!u || typeof u !== 'string') return 'http://216.22.5.245:3002';
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function getConfigPaths() {
  const userData = app.getPath('userData');
  const besideExe = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'config.json')
    : path.join(__dirname, 'config.json');
  const besideEnv = app.isPackaged
    ? path.join(path.dirname(process.execPath), '.env')
    : path.join(__dirname, '.env');
  return {
    besideExe,
    besideEnv,
    userDataConfig: path.join(userData, 'config.json'),
    userDataEnv: path.join(userData, '.env'),
    dedupFile: path.join(userData, 'print-dedup.json'),
  };
}

function loadMergedConfig() {
  if (!app.isPackaged) loadDevEnv();

  const paths = getConfigPaths();
  const merged = { ...process.env };

  const tryMergeFile = (filePath) => {
    const j = readJsonSafe(filePath);
    if (j && typeof j === 'object') {
      for (const [k, v] of Object.entries(j)) {
        if (v !== undefined && v !== null) merged[k] = String(v);
      }
    }
  };

  tryMergeFile(paths.besideExe);
  tryMergeFile(paths.userDataConfig);

  if (app.isPackaged && fs.existsSync(paths.besideEnv)) {
    require('dotenv').config({ path: paths.besideEnv });
    Object.assign(merged, process.env);
  }
  if (fs.existsSync(paths.userDataEnv)) {
    require('dotenv').config({ path: paths.userDataEnv });
    Object.assign(merged, process.env);
  }

  return { merged, paths };
}

function getSettings(merged, session) {
  const apiUrl = normalizeApiBase(
    session?.apiHttpBase ||
      merged.API_HTTP_BASE ||
      merged.apiHttpBase ||
      merged.API_URL ||
      merged.apiUrl ||
      'http://216.22.5.245:3002'
  );
  const lojaId = session?.lojaId != null ? Number(session.lojaId) : 0;

  let scriptPath =
    merged.AUTO_PRINT_SCRIPT_PATH ||
    merged.autoPrintScriptPath ||
    path.join(__dirname, 'backend', 'scripts', 'auto_print_preparing_orders.js');
  scriptPath = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(__dirname, scriptPath);

  const triggers = (merged.PRINT_TRIGGERS || merged.printTriggers || 'both')
    .toString()
    .trim()
    .toLowerCase();
  const dedupPolicy = (merged.DEDUP_POLICY || merged.dedupPolicy || 'one_per_order')
    .toString()
    .trim()
    .toLowerCase();

  const useElectronAsNode = (merged.USE_ELECTRON_AS_NODE ?? merged.useElectronAsNode ?? '1') !== '0';

  return {
    apiUrl,
    lojaId,
    scriptPath,
    triggers,
    dedupPolicy,
    useElectronAsNode,
  };
}

function buildConfig(session, merged, paths) {
  return {
    merged,
    paths,
    settings: getSettings(merged, session),
    session,
  };
}

function shouldTrigger(kind, triggers) {
  if (triggers === 'new_order') return kind === 'new_order' || kind === 'NEW_ORDER';
  if (triggers === 'being_prepared')
    return kind === 'being_prepared' || kind === 'ORDER_BEING_PREPARED';
  return (
    kind === 'new_order' ||
    kind === 'NEW_ORDER' ||
    kind === 'being_prepared' ||
    kind === 'ORDER_BEING_PREPARED'
  );
}

function kindFromSocketEvent(eventName, payload) {
  if (eventName === 'new-order') return 'new_order';
  if (eventName === 'order-being-prepared') return 'being_prepared';
  if (eventName === 'realtime-event') {
    const t = (payload && (payload.type || payload.eventType || payload.event)) || '';
    const u = String(t).toUpperCase();
    if (u === 'NEW_ORDER') return 'new_order';
    if (u === 'ORDER_BEING_PREPARED' || u === 'BEING_PREPARED') return 'being_prepared';
  }
  return null;
}

function orderDataFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.payload != null && typeof payload.payload === 'object') return payload.payload;
  return payload;
}

function extractOrderId(payload) {
  const data = orderDataFromPayload(payload);
  if (!data || typeof data !== 'object') return null;
  return data.orderId ?? data.id ?? data.pedidoId ?? data.pedido?.id ?? null;
}

function extractLojaIdFromPayload(payload) {
  const data = orderDataFromPayload(payload);
  if (!data || typeof data !== 'object') return NaN;
  if (data.lojaId !== undefined) return Number(data.lojaId);
  if (data.loja?.id !== undefined) return Number(data.loja.id);
  return NaN;
}

function normalizePayloadForScript(payload, kind) {
  const base = orderDataFromPayload(payload);
  if (base && typeof base === 'object' && !base._printKind) {
    return { ...base, _printKind: kind, _source: 'mira-printer-agent' };
  }
  return base;
}

class DedupStore {
  constructor(filePath, policy) {
    this.filePath = filePath;
    this.policy = policy;
    this.keys = new Set();
    this.load();
  }

  load() {
    try {
      const data = readJsonSafe(this.filePath);
      if (data && Array.isArray(data.keys)) data.keys.forEach((k) => this.keys.add(k));
    } catch (_) {}
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ keys: [...this.keys], updatedAt: Date.now() }, null, 0),
        'utf8'
      );
    } catch (e) {
      console.error('[dedup] save failed', e.message);
    }
  }

  keyFor(orderId, kind) {
    const o = orderId != null ? String(orderId) : 'unknown';
    if (this.policy === 'one_per_order') return `order:${o}`;
    return `${o}:${kind}`;
  }

  isDup(orderId, kind) {
    return this.keys.has(this.keyFor(orderId, kind));
  }

  mark(orderId, kind) {
    this.keys.add(this.keyFor(orderId, kind));
    this.save();
  }
}

let mainWindow = null;
let setupWindow = null;
let tray = null;
let socket = null;
let dedupStore = null;
let configBundle = null;
const lastStatus = { connection: 'desconectado', lastPrint: null, lastError: null };
const printQueue = [];
let isPrinting = false;
let isQuittingForUpdate = false;

const windows = new Set();

function broadcastStatus() {
  const payload = {
    connection: lastStatus.connection,
    lastPrint: lastStatus.lastPrint,
    lastError: lastStatus.lastError,
  };
  windows.forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('status', payload);
  });
  if (tray) {
    tray.setToolTip(
      `Mira Printer — ${lastStatus.connection}` +
        (lastStatus.lastPrint ? ` | Último: ${lastStatus.lastPrint}` : '')
    );
  }
}

function setConnection(state) {
  lastStatus.connection = state;
  broadcastStatus();
}

function setLastPrint(summary) {
  lastStatus.lastPrint = summary;
  broadcastStatus();
}

function setLastError(msg) {
  lastStatus.lastError = msg;
  broadcastStatus();
}

function runPrintScript(mergedEnv, scriptPath, payload, useElectronAsNode, done) {
  const printSettings = loadPrintSettings();
  const env = {
    ...mergedEnv,
    AUTO_PRINT_ORDER_JSON: JSON.stringify(payload),
    MIRA_PRINTER_TYPE: printSettings.printerType || '',
    MIRA_PRINTER_TARGET: printSettings.printerTarget || '',
    MIRA_PAPER_WIDTH_MM: String(printSettings.paperWidthMm || 80),
    MIRA_FONT_SCALE: printSettings.fontScale || 'normal',
  };

  const logPrefix = `[print ${new Date().toISOString()}]`;

  if (useElectronAsNode) {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    attachPrintLogs(child, logPrefix, done);
    return;
  }

  const nodeCmd = mergedEnv.NODE_BINARY || 'node';
  const child = spawn(nodeCmd, [scriptPath], {
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachPrintLogs(child, logPrefix, done);
}

function attachPrintLogs(child, logPrefix, done) {
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    if (typeof done === 'function') done();
  };
  child.stdout?.on('data', (d) => process.stdout.write(`${logPrefix} ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`${logPrefix} [err] ${d}`));
  child.on('error', (err) => {
    console.error(`${logPrefix} spawn error`, err.message);
    finishOnce();
  });
  child.on('close', (code) => {
    if (code !== 0) console.error(`${logPrefix} exit ${code}`);
    finishOnce();
  });
}

function processPrintQueue(bundle) {
  if (isPrinting) return;
  const next = printQueue.shift();
  if (!next) return;
  isPrinting = true;

  runPrintScript(bundle.merged, bundle.settings.scriptPath, next.payload, bundle.settings.useElectronAsNode, () => {
    isPrinting = false;
    processPrintQueue(bundle);
  });
}

function enqueuePrint(bundle, payload) {
  printQueue.push({ payload });
  processPrintQueue(bundle);
}

function handleIncomingEvent(bundle, eventName, rawPayload) {
  const { settings } = bundle;
  const normalized =
    eventName === 'realtime-event' &&
    rawPayload &&
    typeof rawPayload === 'object' &&
    rawPayload.data &&
    typeof rawPayload.data === 'object' &&
    !Array.isArray(rawPayload.data)
      ? { ...rawPayload, ...rawPayload.data }
      : rawPayload;

  const kind = kindFromSocketEvent(eventName, normalized);
  if (!kind) return;
  if (!shouldTrigger(kind, settings.triggers)) return;

  const payload = normalized && typeof normalized === 'object' ? normalized : {};
  if (!(settings.lojaId > 0)) return;

  const payloadLoja = extractLojaIdFromPayload(payload);
  if (Number.isFinite(payloadLoja) && payloadLoja !== settings.lojaId) {
    console.warn('[filter] payload de outra loja ignorado', payloadLoja);
    return;
  }

  const orderId = extractOrderId(payload);
  if (dedupStore.isDup(orderId, kind)) {
    console.log('[dedup] skip', orderId, kind);
    return;
  }

  dedupStore.mark(orderId, kind);
  const toSend = normalizePayloadForScript(payload, kind);

  setLastPrint(
    orderId != null ? `Pedido ${orderId} (${kind})` : `${kind} @ ${new Date().toLocaleString('pt-BR')}`
  );

  enqueuePrint(bundle, toSend);
}

function connectSocket(bundle, token) {
  if (!token) return;

  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch (_) {}
    socket = null;
  }

  const url = bundle.settings.apiUrl;
  const opts = {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
    auth: { token },
  };

  socket = io(url, opts);

  socket.on('connect', () => {
    console.log('[socket] connected', url);
    setConnection('conectado');
    setLastError(null);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnect', reason);
    setConnection('desconectado');
  });

  socket.on('connect_error', (err) => {
    const msg = err?.message || String(err);
    console.error('[socket] connect_error', msg);
    setConnection('desconectado');
    setLastError(msg);

    const relog =
      /TOKEN_EXPIRED|MISSING_TOKEN|FORBIDDEN|UNAUTHORIZED|INVALID_TOKEN|NOT_AUTHORIZED/i.test(msg);
    if (relog) {
      setLastError('Sessão inválida ou expirada — abra Login e entre novamente.');
    }
  });

  const forward = (ev) => (payload) => {
    try {
      handleIncomingEvent(bundle, ev, payload);
    } catch (e) {
      console.error('[handler]', ev, e);
      setLastError(e.message);
    }
  };

  // Não escutar `realtime-event`: o mesmo pedido já vem em `new-order` / `order-being-prepared`
  // (o servidor emite os dois; ouvir os três gera impressão duplicada).
  socket.on('new-order', forward('new-order'));
  socket.on('order-being-prepared', forward('order-being-prepared'));
}

function trayImage() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
  }
  return image;
}

function createTray() {
  const image = trayImage();
  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    {
      label: 'Mostrar janela',
      click: () => showMainWindow(),
    },
    {
      label: 'Login / alterar conta…',
      click: () => createSetupWindow(),
    },
    {
      label: 'Abrir pasta (userData)',
      click: () => shell.openPath(app.getPath('userData')),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showMainWindow());
  broadcastStatus();
}

function createMainWindow(startHidden) {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    show: !startHidden,
    skipTaskbar: startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.add(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    windows.delete(mainWindow);
    mainWindow = null;
  });

  mainWindow.on('close', (e) => {
    if (isQuittingForUpdate) return;
    if (process.platform === 'darwin') return;
    e.preventDefault();
    mainWindow.hide();
  });
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[update] checking');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[update] available', info?.version || '');
    setLastError(null);
    setLastPrint(`Atualizacao ${info?.version || ''} em download...`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[update] no updates');
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message || String(err);
    console.error('[update] error', msg);
    setLastError(`Falha ao buscar atualizacao: ${msg}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[update] downloaded', info?.version || '');
    setLastError(null);
    setLastPrint(`Atualizacao ${info?.version || ''} pronta. Reiniciando...`);
    isQuittingForUpdate = true;
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 1500);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    const msg = err?.message || String(err);
    console.error('[update] check failed', msg);
  });
}

function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 460,
    height: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(false);
  mainWindow.show();
  mainWindow.setSkipTaskbar(false);
}

function applyOpenAtLogin(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
  });
}

function registerIpc() {
  ipcMain.handle('get-status', () => {
    const l = typeof app.getLoginItemSettings === 'function' ? app.getLoginItemSettings() : {};
    return { ...lastStatus, openAtLogin: !!l.openAtLogin };
  });

  ipcMain.handle('get-session-info', () => {
    const ud = app.getPath('userData');
    const sess = loadSession(ud);
    const { merged, paths } = loadMergedConfig();
    const b = sess ? buildConfig(sess, merged, paths) : buildConfig(null, merged, paths);
    return {
      loggedIn: !!sess?.token,
      apiHttpBase: b.settings.apiUrl,
      lojaSubdominio: sess?.lojaSubdominio || '',
      lojaNomeDisplay: sess?.lojaNome || '',
      lojaId: b.settings.lojaId,
      userData: ud,
      besideConfig: paths.besideExe,
    };
  });

  ipcMain.handle('auth-login', async (_e, body) => {
    const base = normalizeApiBase(body.apiHttpBase);
    const url = `${base}/api/auth/login-store-admin`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        telefone: String(body.telefone || '').trim(),
        password: body.password,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.message || text;
      } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const data = JSON.parse(text);
    const token = data.token;
    if (!token) throw new Error('Resposta sem token.');

    const userData = app.getPath('userData');
    saveSession(userData, {
      apiHttpBase: base,
      lojaSubdominio: data.loja?.subdominio || data.subdominio || '',
      lojaId: data.loja?.id,
      lojaNome: data.loja?.nome,
      token,
    });

    const { merged, paths } = loadMergedConfig();
    const sess = loadSession(userData);
    configBundle = buildConfig(sess, merged, paths);

    if (socket) {
      try {
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
    connectSocket(configBundle, token);

    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();

    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(false);
    else {
      mainWindow.show();
      mainWindow.setSkipTaskbar(false);
    }

    return { ok: true, loja: data.loja, subdominio: data.subdominio };
  });

  ipcMain.handle('auth-logout', async () => {
    const userData = app.getPath('userData');
    clearSession(userData);
    if (socket) {
      try {
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
    setConnection('desconectado');
    setLastError('Faça login novamente.');
    configBundle = null;
    createSetupWindow();
    return { ok: true };
  });

  ipcMain.on('set-open-at-login', (_e, v) => applyOpenAtLogin(!!v));
  ipcMain.on('show-window', () => showMainWindow());
  ipcMain.on('open-setup', () => createSetupWindow());

  ipcMain.handle('get-print-settings', async () => {
    const settings = loadPrintSettings();
    const printers = await listWindowsPrinters();
    return { settings, printers };
  });

  ipcMain.handle('save-print-settings', (_e, settings) => {
    return savePrintSettings(settings);
  });
}

function initApp() {
  const userData = app.getPath('userData');
  const { merged, paths } = loadMergedConfig();
  const session = loadSession(userData);

  const st0 = getSettings(merged, session);
  dedupStore = new DedupStore(paths.dedupFile, st0.dedupPolicy);
  configBundle = session?.token ? buildConfig(session, merged, paths) : null;

  registerIpc();
  createTray();
  setupAutoUpdate();

  const startMinimized =
    (merged.START_MINIMIZED ?? merged.startMinimized ?? '1') !== '0' &&
    (process.argv.includes('--hidden') || merged.HIDDEN === '1');

  if (session?.token) {
    createMainWindow(startMinimized);
    connectSocket(configBundle, session.token);
  } else {
    createSetupWindow();
  }

  if (merged.OPEN_AT_LOGIN === '1' || merged.openAtLogin === '1') {
    applyOpenAtLogin(true);
  }

  if (!fs.existsSync(st0.scriptPath)) {
    console.error('[config] Script de impressão não encontrado:', st0.scriptPath);
  }
}

app.whenReady().then(initApp);

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuittingForUpdate = true;
  if (socket) {
    try {
      socket.disconnect();
    } catch (_) {}
  }
});
