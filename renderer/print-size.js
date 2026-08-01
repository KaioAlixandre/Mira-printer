const paperPresetsEl = document.getElementById('paperPresets');
const paperCustomFieldEl = document.getElementById('paperCustomField');
const paperWidthEl = document.getElementById('paperWidthMm');
const contentAutoEl = document.getElementById('contentAuto');
const contentFieldEl = document.getElementById('contentField');
const contentWidthEl = document.getElementById('contentWidthMm');
const contentWidthLabelEl = document.getElementById('contentWidthLabel');
const fontPresetsEl = document.getElementById('fontPresets');
const fontScaleEl = document.getElementById('fontScalePercent');
const fontScaleLabelEl = document.getElementById('fontScaleLabel');
const lineHeightEl = document.getElementById('lineHeight');
const lineHeightLabelEl = document.getElementById('lineHeightLabel');
const previewPaperEl = document.getElementById('previewPaper');
const previewContentEl = document.getElementById('previewContent');
const previewMetaEl = document.getElementById('previewMeta');
const btnReset = document.getElementById('btnReset');
const btnBack = document.getElementById('btnBack');
const btnSave = document.getElementById('btnSave');
const btnMinimize = document.getElementById('btnMinimize');
const btnClose = document.getElementById('btnClose');

const DEFAULTS = { paperWidthMm: 80, contentWidthMm: 0, fontScalePercent: 100, lineHeight: 1.35 };
const PREVIEW_PX_PER_MM = 3.4;
const MONO_CHAR_RATIO = 0.6;
const PT_IN_MM = 0.3528;
const BASE_FONT_PT = 13;

const state = { ...DEFAULTS };

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Espelha resolveReceiptContentMm/resolveReceiptWidth de auto_print_preparing_orders.js
function resolveContentMm() {
  const paper = state.paperWidthMm;
  if (state.contentWidthMm > 0) return Math.round(Math.min(paper, Math.max(30, state.contentWidthMm)));
  if (paper >= 76) return 68;
  return Math.max(40, Math.round(paper * (68 / 80)));
}

function resolveColumns() {
  const baseCols = resolveContentMm() * (38 / 80);
  return Math.max(16, Math.round(baseCols / (state.fontScalePercent / 100)));
}

function resolveFontPt() {
  const contentMm = resolveContentMm();
  const cols = resolveColumns();
  const charWidthMm = (contentMm * 0.98) / cols;
  const fitted = charWidthMm / (MONO_CHAR_RATIO * PT_IN_MM);
  return Math.min(fitted, BASE_FONT_PT * (state.fontScalePercent / 100));
}

function padRight(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function center(text, width) {
  const s = String(text ?? '').trim();
  if (s.length >= width) return s.slice(0, width);
  const left = Math.floor((width - s.length) / 2);
  return ' '.repeat(left) + s;
}

function sectionHeader(label, width) {
  const inner = ` ${label} `;
  if (inner.length >= width) return label.slice(0, width);
  const sideLen = Math.floor((width - inner.length) / 2);
  return '-'.repeat(sideLen) + inner + '-'.repeat(width - sideLen - inner.length);
}

function totalRow(label, value, width) {
  return padRight(label, Math.max(1, width - value.length)) + value;
}

function buildSampleReceipt(width) {
  return [
    center('MIRA DELIVERY', width),
    '-'.repeat(width),
    center('PEDIDO #1234', width),
    center('01/08/2026 19:42', width),
    sectionHeader('ENTREGA', width),
    'Rua das Flores, 250',
    'Bairro: Centro',
    sectionHeader('ITENS', width),
    totalRow('1x Pizza Calabresa', '45,00', width),
    '  + Borda catupiry',
    totalRow('2x Refrigerante 2L', '24,00', width),
    sectionHeader('TOTAIS', width),
    totalRow('Subtotal', '69,00', width),
    totalRow('Taxa de entrega', '6,00', width),
    totalRow('TOTAL', '75,00', width),
    '-'.repeat(width),
    center('Obrigado pela preferencia!', width),
  ].join('\n');
}

function renderPreview() {
  const contentMm = resolveContentMm();
  const cols = resolveColumns();
  const fontPt = resolveFontPt();

  previewPaperEl.style.width = `${state.paperWidthMm * PREVIEW_PX_PER_MM}px`;
  previewContentEl.style.width = `${contentMm * PREVIEW_PX_PER_MM}px`;
  previewContentEl.style.fontSize = `${fontPt * PT_IN_MM * PREVIEW_PX_PER_MM}px`;
  previewContentEl.style.lineHeight = String(state.lineHeight);
  previewContentEl.textContent = buildSampleReceipt(cols);

  const areaText =
    state.contentWidthMm > 0 ? `${contentMm} mm (manual)` : `${contentMm} mm (automática)`;
  previewMetaEl.textContent = `${cols} colunas · fonte ≈ ${fontPt.toFixed(1)} pt · área impressa ${areaText} em papel de ${state.paperWidthMm} mm`;
}

function syncControls() {
  const isCustomPaper = state.paperWidthMm !== 58 && state.paperWidthMm !== 80;
  paperPresetsEl.querySelectorAll('.seg-btn').forEach((btn) => {
    const key = btn.dataset.paper;
    const active = key === 'custom' ? isCustomPaper : Number(key) === state.paperWidthMm;
    btn.classList.toggle('active', active);
  });
  paperCustomFieldEl.hidden = !isCustomPaper;
  paperWidthEl.value = String(state.paperWidthMm);

  const auto = state.contentWidthMm <= 0;
  contentAutoEl.checked = auto;
  contentFieldEl.hidden = auto;
  contentWidthEl.max = String(state.paperWidthMm);
  contentWidthEl.value = String(auto ? resolveContentMm() : state.contentWidthMm);
  contentWidthLabelEl.textContent = `${contentWidthEl.value} mm`;

  fontPresetsEl.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.font) === state.fontScalePercent);
  });
  fontScaleEl.value = String(state.fontScalePercent);
  fontScaleLabelEl.textContent = `${state.fontScalePercent}%`;

  lineHeightEl.value = String(state.lineHeight);
  lineHeightLabelEl.textContent = state.lineHeight.toFixed(2);

  renderPreview();
}

function setState(patch) {
  Object.assign(state, patch);
  if (state.contentWidthMm > state.paperWidthMm) state.contentWidthMm = state.paperWidthMm;
  syncControls();
}

paperPresetsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  if (btn.dataset.paper === 'custom') {
    const current = state.paperWidthMm;
    setState({ paperWidthMm: current === 58 || current === 80 ? 76 : current });
    paperWidthEl.focus();
    return;
  }
  setState({ paperWidthMm: Number(btn.dataset.paper) });
});

paperWidthEl.addEventListener('input', () => {
  setState({ paperWidthMm: Math.round(clamp(paperWidthEl.value, 40, 120, 80)) });
});

contentAutoEl.addEventListener('change', () => {
  setState({ contentWidthMm: contentAutoEl.checked ? 0 : resolveContentMm() });
});

contentWidthEl.addEventListener('input', () => {
  setState({ contentWidthMm: Math.round(clamp(contentWidthEl.value, 30, state.paperWidthMm, 68)) });
});

fontPresetsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setState({ fontScalePercent: Number(btn.dataset.font) });
});

fontScaleEl.addEventListener('input', () => {
  setState({ fontScalePercent: Math.round(clamp(fontScaleEl.value, 60, 200, 100)) });
});

lineHeightEl.addEventListener('input', () => {
  setState({ lineHeight: Math.round(clamp(lineHeightEl.value, 1, 2.2, 1.35) * 100) / 100 });
});

btnReset.addEventListener('click', () => setState({ ...DEFAULTS }));
btnBack.addEventListener('click', () => window.mira.closeWindow());
if (btnMinimize) btnMinimize.addEventListener('click', () => window.mira.minimizeWindow());
if (btnClose) btnClose.addEventListener('click', () => window.mira.closeWindow());

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  try {
    const { settings } = await window.mira.getPrintSettings();
    await window.mira.savePrintSettings({
      ...settings,
      paperWidthMm: state.paperWidthMm,
      contentWidthMm: state.contentWidthMm,
      fontScalePercent: state.fontScalePercent,
      lineHeight: state.lineHeight,
    });
    showSavePopup('Tamanho da impressão atualizado!');
  } finally {
    btnSave.disabled = false;
  }
});

function showSavePopup(message) {
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
  setTimeout(close, 2400);
}

window.mira.getPrintSettings().then(({ settings }) => {
  setState({
    paperWidthMm: Math.round(clamp(settings.paperWidthMm, 40, 120, DEFAULTS.paperWidthMm)),
    contentWidthMm: Math.round(clamp(settings.contentWidthMm, 0, 120, 0)),
    fontScalePercent: Math.round(clamp(settings.fontScalePercent, 60, 200, DEFAULTS.fontScalePercent)),
    lineHeight: clamp(settings.lineHeight, 1, 2.2, DEFAULTS.lineHeight),
  });
});

syncControls();
