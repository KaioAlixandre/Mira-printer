const connEl = document.getElementById('conn');
const lastEl = document.getElementById('last');
const errEl = document.getElementById('err');
const errRow = document.getElementById('errRow');
const storeNameEl = document.getElementById('storeName');
const loginEl = document.getElementById('login');
const btnSetup = document.getElementById('btnSetup');
const btnLogout = document.getElementById('btnLogout');
const printerTargetSelectEl = document.getElementById('printerTargetSelect');
const printerTargetInputEl = document.getElementById('printerTargetInput');
const paperWidthEl = document.getElementById('paperWidthMm');
const fontScaleEl = document.getElementById('fontScale');
const btnSavePrintEl = document.getElementById('btnSavePrint');
const printBellEnabledEl = document.getElementById('printBellEnabled');
const printBellVolumeEl = document.getElementById('printBellVolume');
const btnMinimize = document.getElementById('btnMinimize');
const btnClose = document.getElementById('btnClose');

errRow.hidden = true;
errEl.textContent = '';

function render(s) {
  const c = s.connection || '—';
  connEl.textContent = c;
  connEl.className = 'badge ' + (c === 'conectado' ? 'ok' : 'bad');
  lastEl.textContent = s.lastPrint || '—';
  const errorMsg = s.lastError && String(s.lastError).trim();
  if (errorMsg) {
    errRow.hidden = false;
    errEl.textContent = errorMsg;
  } else {
    errRow.hidden = true;
    errEl.textContent = '';
  }
  if (typeof s.openAtLogin === 'boolean') {
    loginEl.checked = s.openAtLogin;
  }
}

function refreshStoreInfo() {
  window.mira.getSessionInfo().then((h) => {
    const nome = h.lojaNomeDisplay || `Loja #${h.lojaId || '-'}`;
    storeNameEl.textContent = h.loggedIn ? nome : 'Sem sessão';
  });
}

window.mira.getStatus().then((s) => render(s));
refreshStoreInfo();
loadPrintSettings();

const off = window.mira.onStatus((s) => {
  render(s);
  refreshStoreInfo();
});
window.addEventListener('beforeunload', () => off());

loginEl.addEventListener('change', () => {
  window.mira.setOpenAtLogin(loginEl.checked);
});

btnSetup.addEventListener('click', () => window.mira.openSetup());
btnLogout.addEventListener('click', async () => {
  await window.mira.logout();
  refreshStoreInfo();
});

if (btnMinimize) btnMinimize.addEventListener('click', () => window.mira.minimizeWindow());
if (btnClose) btnClose.addEventListener('click', () => window.mira.closeWindow());

function fillPrinters(printers) {
  printerTargetSelectEl.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Selecione...';
  printerTargetSelectEl.appendChild(first);
  (printers || []).forEach((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    printerTargetSelectEl.appendChild(o);
  });
}

function syncPrintBellControls() {
  const on = printBellEnabledEl.checked;
  printBellVolumeEl.disabled = !on;
}

printBellEnabledEl.addEventListener('change', syncPrintBellControls);

async function loadPrintSettings() {
  const { settings, printers } = await window.mira.getPrintSettings();
  fillPrinters(printers);
  paperWidthEl.value = String(settings.paperWidthMm || 80);
  fontScaleEl.value = settings.fontScale || 'normal';
  printerTargetInputEl.value = settings.printerTarget || '';
  if (settings.printerTarget) {
    printerTargetSelectEl.value = settings.printerTarget;
  }
  printBellEnabledEl.checked = settings.printBellEnabled !== false;
  const pct = Math.round((settings.printBellVolume ?? 0.88) * 100);
  printBellVolumeEl.value = String(Math.min(100, Math.max(0, pct)));
  syncPrintBellControls();
}

printerTargetSelectEl.addEventListener('change', () => {
  if (printerTargetSelectEl.value) {
    printerTargetInputEl.value = printerTargetSelectEl.value;
  }
});

btnSavePrintEl.addEventListener('click', async () => {
  await window.mira.savePrintSettings({
    printerType: 'windows_spooler',
    printerTarget: printerTargetInputEl.value.trim(),
    paperWidthMm: Number(paperWidthEl.value || 80),
    fontScale: fontScaleEl.value,
    printBellEnabled: printBellEnabledEl.checked,
    printBellVolume: Number(printBellVolumeEl.value || 0) / 100,
  });
  showSavePopup();
});

function showSavePopup(message = 'Configuração salva com sucesso!') {
  const existing = document.getElementById('savePopup');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'savePopup';
  overlay.className = 'save-popup-overlay';
  overlay.innerHTML = `
    <div class="save-popup" role="alertdialog" aria-live="polite" aria-label="Configuração salva">
      <div class="save-popup-icon" aria-hidden="true">✓</div>
      <p class="save-popup-title">Salvo!</p>
      <p class="save-popup-msg">${message}</p>
      <button type="button" class="save-popup-btn">OK</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.save-popup-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  setTimeout(close, 2800);
}
