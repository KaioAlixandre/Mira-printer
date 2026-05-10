const connEl = document.getElementById('conn');
const lastEl = document.getElementById('last');
const errEl = document.getElementById('err');
const errRow = document.getElementById('errRow');
const storeNameEl = document.getElementById('storeName');
const loginEl = document.getElementById('login');
const btnSetup = document.getElementById('btnSetup');
const btnLogout = document.getElementById('btnLogout');
const printerTypeEl = document.getElementById('printerType');
const printerTargetSelectEl = document.getElementById('printerTargetSelect');
const printerTargetInputEl = document.getElementById('printerTargetInput');
const paperWidthEl = document.getElementById('paperWidthMm');
const fontScaleEl = document.getElementById('fontScale');
const btnSavePrintEl = document.getElementById('btnSavePrint');
const printBellEnabledEl = document.getElementById('printBellEnabled');
const printBellVolumeEl = document.getElementById('printBellVolume');

function render(s) {
  const c = s.connection || '—';
  connEl.textContent = c;
  connEl.className = 'badge ' + (c === 'conectado' ? 'ok' : 'bad');
  lastEl.textContent = s.lastPrint || '—';
  if (s.lastError) {
    errRow.hidden = false;
    errEl.textContent = s.lastError;
  } else {
    errRow.hidden = true;
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
  printerTypeEl.value = settings.printerType || '';
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
    printerType: printerTypeEl.value,
    printerTarget: printerTargetInputEl.value.trim(),
    paperWidthMm: Number(paperWidthEl.value || 80),
    fontScale: fontScaleEl.value,
    printBellEnabled: printBellEnabledEl.checked,
    printBellVolume: Number(printBellVolumeEl.value || 0) / 100,
  });
});
