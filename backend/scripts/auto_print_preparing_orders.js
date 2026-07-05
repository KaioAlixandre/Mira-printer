/*
  Script mock de autoimpressão:
  gera um arquivo .txt para cada pedido em backend/prints/.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

function parsePayload() {
  const filePath = String(process.env.AUTO_PRINT_ORDER_JSON_FILE || '').trim();
  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const raw = process.env.AUTO_PRINT_ORDER_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const payload = parsePayload();

if (!payload?.id) {
  console.error('AUTO_PRINT_ORDER_JSON ausente ou inválido.');
  process.exit(1);
}

console.log(
  `Pedido #${payload.dailyNumber || payload.id} (id=${payload.id}) pronto para impressão automática.`
);

function resolveWritablePrintsDir() {
  const envDir = String(process.env.MIRA_PRINTS_DIR || '').trim();
  if (envDir) return envDir;

  const userData = String(process.env.MIRA_USER_DATA || '').trim();
  if (userData) return path.join(userData, 'prints');

  // Fallback para desenvolvimento local (fora de app.asar).
  return path.resolve(__dirname, '..', 'prints');
}

const printsDir = resolveWritablePrintsDir();
if (!fs.existsSync(printsDir)) {
  fs.mkdirSync(printsDir, { recursive: true });
}

const now = new Date();
const localDateTime = now.toLocaleString('pt-BR');
const safeTimestamp = now.toISOString().replace(/[:.]/g, '-');
const fileName = `pedido_${payload.id}_${safeTimestamp}.txt`;
const filePath = path.join(printsDir, fileName);

function brl(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

function formatDate(dateValue) {
  if (!dateValue) return '-';
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue);
  return d.toLocaleString('pt-BR');
}

function formatPaymentMethod(method) {
  const raw = String(method || '').toUpperCase();
  if (raw === 'CREDIT_CARD') return 'Cartao de credito';
  if (raw === 'DEBIT_CARD') return 'Cartao de debito';
  if (raw === 'PIX') return 'PIX';
  if (raw === 'CASH_ON_DELIVERY') return 'Dinheiro';
  return method || '-';
}

function formatDeliveryType(type) {
  const raw = String(type || '').toLowerCase();
  if (raw === 'delivery') return 'Entrega';
  if (raw === 'pickup') return 'Retirada';
  if (raw === 'dine_in') return 'Mesa';
  return type || '-';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (text) return text;
  }
  return '';
}

function parseOptionsSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getItemOptionsSnapshot(item) {
  return parseOptionsSnapshot(
    item?.opcoesSelecionadas ||
      item?.opcoesSelecionadasSnapshot ||
      item?.selectedOptionsSnapshot ||
      item?.selectedOptions
  );
}

function getPrintFlavorCatalog() {
  if (Array.isArray(payload?.__printFlavors) && payload.__printFlavors.length) {
    return payload.__printFlavors;
  }
  if (Array.isArray(payload?.flavors) && payload.flavors.length) {
    return payload.flavors;
  }
  return [];
}

function resolveItemName(item) {
  const snap = getItemOptionsSnapshot(item);
  return firstNonEmpty(
    item?.produto?.nome,
    item?.produto?.name,
    item?.product?.nome,
    item?.product?.name,
    item?.nomeProduto,
    item?.produtoNome,
    item?.nome,
    item?.name,
    snap?.nomeProduto,
    snap?.productName,
    snap?.customAcai?.title,
    snap?.customAcai?.label,
    snap?.customProduct?.title,
    snap?.customProduct?.label,
    snap?.customSorvete?.title,
    snap?.customSorvete?.label,
    'Produto'
  );
}

function getItemAdditionalsDetailed(item) {
  const result = [];
  const resolveAdditionalValue = (additional) => Number(
    additional?.adicional?.precoNoPedido ??
    additional?.adicional?.priceAtOrder ??
    additional?.adicional?.preco ??
    additional?.adicional?.price ??
    additional?.adicional?.valor ??
    additional?.adicional?.value ??
    additional?.precoNoPedido ??
    additional?.priceAtOrder ??
    additional?.preco ??
    additional?.price ??
    additional?.valor ??
    additional?.value ??
    0
  );
  const pushAdditional = (qtyRaw, nameRaw, valueRaw) => {
    const name = firstNonEmpty(nameRaw, 'Adicional');
    const qty = Number(qtyRaw || 1);
    const value = Number(valueRaw || 0);
    result.push({ qty, name, value });
  };

  const additionals = Array.isArray(item?.adicionais) ? item.adicionais : [];
  additionals.forEach((a) => {
    pushAdditional(
      a?.quantidade,
      firstNonEmpty(a?.adicional?.nome, a?.adicional?.name, a?.nome, a?.name),
      resolveAdditionalValue(a)
    );
  });

  const itemPedidoAdicionais = Array.isArray(item?.item_pedido_adicionais) ? item.item_pedido_adicionais : [];
  itemPedidoAdicionais.forEach((a) => {
    pushAdditional(
      a?.quantidade,
      firstNonEmpty(a?.adicional?.nome, a?.adicional?.name, a?.nome, a?.name),
      resolveAdditionalValue(a)
    );
  });

  const frontendAdditionals = Array.isArray(item?.additionals) ? item.additionals : [];
  frontendAdditionals.forEach((a) => {
    pushAdditional(
      a?.quantity ?? a?.quantidade ?? 1,
      firstNonEmpty(a?.name, a?.nome, a?.label),
      Number(a?.value ?? a?.valor ?? a?.price ?? a?.preco ?? 0)
    );
  });

  const snapshot = getItemOptionsSnapshot(item);
  const snapshotAdditionals = Array.isArray(snapshot?.adicionais)
    ? snapshot.adicionais
    : Array.isArray(snapshot?.additionals)
      ? snapshot.additionals
      : [];
  snapshotAdditionals.forEach((a) => {
    if (typeof a === 'string') {
      pushAdditional(1, a, 0);
      return;
    }
    pushAdditional(
      a?.quantidade ?? a?.quantity ?? 1,
      firstNonEmpty(a?.nome, a?.name, a?.label),
      Number(a?.preco ?? a?.price ?? a?.valor ?? a?.value ?? 0)
    );
  });

  return result;
}

function parseItemAdditionals(item) {
  return getItemAdditionalsDetailed(item)
    .map((a) => `${a.qty}x ${a.name} (+${brl(a.value)})`)
    .join(' | ');
}

function parseItemComplements(item) {
  const complementNames = [];
  const pushIfValid = (name) => {
    const normalized = firstNonEmpty(name);
    if (normalized) complementNames.push(normalized);
  };

  const complements = Array.isArray(item?.complementos) ? item.complementos : [];
  complements.forEach((c) => {
    pushIfValid(c?.complemento?.nome);
    pushIfValid(c?.complemento?.name);
    pushIfValid(c?.nome);
    pushIfValid(c?.name);
  });

  const itemPedidoComplementos = Array.isArray(item?.item_pedido_complementos)
    ? item.item_pedido_complementos
    : [];
  itemPedidoComplementos.forEach((c) => {
    pushIfValid(c?.complemento?.nome);
    pushIfValid(c?.complemento?.name);
    pushIfValid(c?.nome);
    pushIfValid(c?.name);
  });

  const frontendComplements = Array.isArray(item?.complements) ? item.complements : [];
  frontendComplements.forEach((c) => {
    pushIfValid(c?.name);
    pushIfValid(c?.nome);
    pushIfValid(c?.label);
  });

  const snapshot = getItemOptionsSnapshot(item);
  const snapshotComplements = Array.isArray(snapshot?.complementos)
    ? snapshot.complementos
    : Array.isArray(snapshot?.complements)
      ? snapshot.complements
      : [];
  snapshotComplements.forEach((c) => {
    if (typeof c === 'string') {
      pushIfValid(c);
      return;
    }
    pushIfValid(c?.nome);
    pushIfValid(c?.name);
    pushIfValid(c?.label);
  });

  const customData = snapshot?.customAcai || snapshot?.customSorvete || snapshot?.customProduct;
  if (customData?.complementNames && Array.isArray(customData.complementNames)) {
    customData.complementNames.forEach(pushIfValid);
  }

  return [...new Set(complementNames)].join(', ');
}

function parseItemFlavors(item) {
  const flavorNames = [];
  const pushIfValid = (name) => {
    const normalized = firstNonEmpty(name);
    if (normalized) flavorNames.push(normalized);
  };

  const fromSabores = Array.isArray(item?.sabores) ? item.sabores : [];
  fromSabores.forEach((s) => {
    pushIfValid(s?.sabor?.nome);
    pushIfValid(s?.sabor?.name);
    pushIfValid(s?.nome);
    pushIfValid(s?.name);
  });

  const fromItemPedidoSabores = Array.isArray(item?.item_pedido_sabores) ? item.item_pedido_sabores : [];
  fromItemPedidoSabores.forEach((s) => {
    pushIfValid(s?.sabor?.nome);
    pushIfValid(s?.sabor?.name);
    pushIfValid(s?.nome);
    pushIfValid(s?.name);
  });

  const fromFrontendFlavors = Array.isArray(item?.flavors) ? item.flavors : [];
  fromFrontendFlavors.forEach((s) => {
    pushIfValid(s?.name);
    pushIfValid(s?.nome);
    pushIfValid(s?.label);
  });

  const snapshot = getItemOptionsSnapshot(item);
  const snapshotFlavors = Array.isArray(snapshot?.sabores)
    ? snapshot.sabores
    : Array.isArray(snapshot?.flavors)
      ? snapshot.flavors
      : [];
  snapshotFlavors.forEach((s) => {
    if (typeof s === 'string') {
      pushIfValid(s);
      return;
    }
    pushIfValid(s?.nome);
    pushIfValid(s?.name);
    pushIfValid(s?.label);
  });

  const selectedFlavors = snapshot?.selectedFlavors || snapshot?.flavorIds;
  if (selectedFlavors && typeof selectedFlavors === 'object' && !Array.isArray(selectedFlavors)) {
    const flavorIds = [];
    Object.values(selectedFlavors).forEach((ids) => {
      if (Array.isArray(ids)) {
        ids.forEach((id) => {
          const n = Number(id);
          if (Number.isFinite(n)) flavorIds.push(n);
        });
      }
    });
    if (flavorIds.length) {
      const catalog = getPrintFlavorCatalog();
      catalog.forEach((f) => {
        const id = Number(f?.id);
        if (flavorIds.includes(id)) {
          pushIfValid(f?.name);
          pushIfValid(f?.nome);
        }
      });
    }
  }

  return [...new Set(flavorNames)].join(', ');
}

function getPayloadItems(payloadObj) {
  if (Array.isArray(payloadObj?.itens_pedido)) return payloadObj.itens_pedido;
  if (Array.isArray(payloadObj?.orderitem)) return payloadObj.orderitem;
  return [];
}

function getItemQty(item) {
  return Number(item?.quantidade ?? item?.quantity ?? 0);
}

function getItemBasePrice(item) {
  return Number(item?.precoNoPedido ?? item?.priceAtOrder ?? item?.preco ?? item?.product?.price ?? 0);
}

const items = getPayloadItems(payload);
const subtotal = items.reduce((sum, item) => {
  const qty = getItemQty(item);
  const basePrice = getItemBasePrice(item);
  const additionalsTotal = getItemAdditionalsDetailed(item).reduce((acc, a) => acc + a.value * a.qty, 0);
  const unitTotal = basePrice + additionalsTotal;
  return sum + unitTotal * qty;
}, 0);

const deliveryFee = Number(payload.taxaEntrega ?? payload.deliveryFee ?? 0);
const total = Number(payload.precoTotal ?? payload.totalPrice ?? 0);
const paymentMethodRaw = payload.metodoPagamento || payload.paymentMethod || payload.pagamento?.metodo || '';
const paymentMethod = formatPaymentMethod(paymentMethodRaw);
const isPixPayment = String(paymentMethodRaw).toUpperCase() === 'PIX';
const isCashOnDeliveryPayment = String(paymentMethodRaw).toUpperCase() === 'CASH_ON_DELIVERY';
const isCardPayment = ['CREDIT_CARD', 'DEBIT_CARD'].includes(String(paymentMethodRaw).toUpperCase());
const deliveryTypeRaw = payload.tipoEntrega || payload.deliveryType || '';
const storeName =
  payload.loja?.nome ||
  payload.storeName ||
  payload.nomeLoja ||
  process.env.STORE_NAME ||
  'MIRA DELIVERY';
const printCfg = payload.__autoPrintConfig || {};
const localPrinterType = String(process.env.MIRA_PRINTER_TYPE || '').trim();
const localPrinterTarget = String(process.env.MIRA_PRINTER_TARGET || '').trim();
const localPaperWidth = Number(process.env.MIRA_PAPER_WIDTH_MM || 0);
const fontScale = String(process.env.MIRA_FONT_SCALE || 'normal').toLowerCase();
const printerType = String(localPrinterType || printCfg.printerType || 'mock_txt').toLowerCase();
const printerTarget = String(localPrinterTarget || printCfg.printerTarget || '').trim();
const paperWidthMm = Number(localPaperWidth || printCfg.paperWidthMm || 80);

// Espelha printOrderReceipt.ts (Mira-Delivery Frontend/src/utils/printOrderReceipt.ts)
const RECEIPT_CONTENT_MM = 68;
const RECEIPT_LINE_HEIGHT = 1.35;
const RECEIPT_FONT_PT = {
  body: 13,
  muted: 11,
  small: 10,
  large: 16,
  title: 26,
  heading: 18,
  itemTitle: 14,
  itemPrice: 13,
  itemDetail: 13,
};

function resolveReceiptContentMm(widthMm) {
  const paper = Number(widthMm);
  if (!Number.isFinite(paper) || paper <= 0) return RECEIPT_CONTENT_MM;
  if (paper >= 76) return RECEIPT_CONTENT_MM;
  return Math.max(40, Math.round(paper * (RECEIPT_CONTENT_MM / 80)));
}

function resolveReceiptWidth(widthMm) {
  const contentMm = resolveReceiptContentMm(widthMm);
  // Menos colunas = fonte maior na mesma largura física (~32 cols ref. em 80mm).
  return Math.max(20, Math.round(contentMm * (38 / 80)));
}

const receiptContentMm = resolveReceiptContentMm(paperWidthMm);
const receiptWidth = resolveReceiptWidth(paperWidthMm);

// ─── Helpers de formatação ───────────────────────────────────────────────────

function padRight(value, width) {
  const s = String(value ?? '');
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function padLeft(value, width) {
  const s = String(value ?? '');
  if (s.length >= width) return s.slice(0, width);
  return ' '.repeat(width - s.length) + s;
}

function center(text, width) {
  const s = String(text ?? '').trim();
  if (s.length >= width) return s.slice(0, width);
  const totalPad = width - s.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

function divider(char = '-', width = receiptWidth) {
  return char.repeat(width);
}

function sectionHeader(label, width = receiptWidth) {
  const text = String(label || '').trim();
  if (!text) return divider('-', width);
  const inner = ` ${text} `;
  if (inner.length >= width) return text.slice(0, width);
  const sideLen = Math.floor((width - inner.length) / 2);
  const left = '-'.repeat(sideLen);
  const right = '-'.repeat(width - sideLen - inner.length);
  return left + inner + right;
}

function wrapText(text, width) {
  const clean = String(text || '').trim();
  if (!clean || width < 1) return [];
  const words = clean.split(/\s+/);
  const out = [];
  let line = '';
  words.forEach((word) => {
    let chunk = word;
    while (chunk.length > width) {
      if (line) {
        out.push(line);
        line = '';
      }
      out.push(chunk.slice(0, width));
      chunk = chunk.slice(width);
    }
    if (!chunk) return;
    const next = line ? `${line} ${chunk}` : chunk;
    if (next.length <= width) {
      line = next;
    } else {
      if (line) out.push(line);
      line = chunk;
    }
  });
  if (line) out.push(line);
  return out;
}

function formatItemRow(qty, unitTotal, lineTotal) {
  const qtyCol = 4;
  const unitCol = 10;
  const totalCol = 10;
  return `${padLeft(`${qty}`, qtyCol)} ${padLeft(brl(unitTotal), unitCol)}${padLeft(brl(lineTotal), totalCol)}`;
}

function resolveStoreAddress(payloadObj) {
  const loja = payloadObj?.loja || {};
  const street = firstNonEmpty(loja.rua, loja.endereco, payloadObj?.storeAddressStreet);
  const number = firstNonEmpty(loja.numero, payloadObj?.storeAddressNumber);
  const district = firstNonEmpty(loja.bairro, payloadObj?.storeAddressDistrict);
  if (!street && !number && !district) return '';
  return [street, number, district].filter(Boolean).join(', ');
}

function extractItemObs(item) {
  const snap = getItemOptionsSnapshot(item);
  return firstNonEmpty(item?.observacao, snap?.observacao, snap?.observation);
}

function getDeliveryReference(payloadObj) {
  const direct = firstNonEmpty(payloadObj?.referenciaEntrega, payloadObj?.shippingReference);
  if (direct) return direct;
  const notes = firstNonEmpty(payloadObj?.observacoes, payloadObj?.notes);
  if (!notes) return '';
  for (const line of String(notes).split(/\n/)) {
    const m = line.match(/^Refer[eê]ncia:\s*(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function isCustomProduct(item) {
  const snap = getItemOptionsSnapshot(item);
  return !!(snap?.customAcai || snap?.customSorvete || snap?.customProduct);
}

// ─── Montagem do cupom ───────────────────────────────────────────────────────

const lines = [];
const lineStyles = [];

function pushLine(text, style = 'normal') {
  lines.push(text);
  lineStyles.push(style);
}

// Cabeçalho
pushLine(divider('='), 'normal');
pushLine(center(storeName, receiptWidth), 'normal');
const storeAddress = resolveStoreAddress(payload);
if (storeAddress) {
  wrapText(storeAddress, receiptWidth).forEach((l) => pushLine(center(l, receiptWidth), 'normal'));
}
pushLine(divider('='), 'normal');
pushLine('', 'normal');

// Número e data do pedido
const orderNumber = `PEDIDO #${payload.dailyNumber || payload.id}`;
pushLine(center(orderNumber, receiptWidth), 'normal');
pushLine(center(formatDate(payload.criadoEm || payload.createdAt), receiptWidth), 'normal');
const previsaoEntrega = firstNonEmpty(
  payload.previsaoEntrega,
  payload.janelaEntrega,
  payload.estimatedDeliveryWindow,
  payload.estimatedDeliveryTime
);
if (previsaoEntrega) {
  wrapText(`Previsao: ${previsaoEntrega}`, receiptWidth).forEach((l) =>
    pushLine(center(l, receiptWidth), 'normal')
  );
}
pushLine('', 'normal');

// Tipo de entrega
pushLine(sectionHeader('TIPO DE ENTREGA'), 'normal');
pushLine(center(formatDeliveryType(deliveryTypeRaw), receiptWidth), 'normal');

const deliveryTypeLower = String(deliveryTypeRaw).toLowerCase();
if (deliveryTypeLower === 'delivery') {
  pushLine('', 'normal');
  const ruaEntrega = firstNonEmpty(payload.ruaEntrega, payload.shippingStreet, payload.deliveryStreet);
  const numeroEntrega = firstNonEmpty(payload.numeroEntrega, payload.shippingNumber, payload.deliveryNumber);
  const complementoEntrega = firstNonEmpty(
    payload.complementoEntrega,
    payload.shippingComplement,
    payload.deliveryComplement
  );
  const bairroEntrega = firstNonEmpty(
    payload.bairroEntrega,
    payload.shippingNeighborhood,
    payload.deliveryNeighborhood
  );
  const cidadeEntrega = firstNonEmpty(payload.cidadeEntrega, payload.shippingCity, payload.deliveryCity);
  const cepEntrega = firstNonEmpty(payload.cepEntrega, payload.shippingZipCode, payload.deliveryZipCode, payload.cep);
  const deliveryReference = getDeliveryReference(payload);

  const streetLine = [ruaEntrega, numeroEntrega].filter(Boolean).join(', ');
  const withComp = [streetLine, complementoEntrega ? `Comp: ${complementoEntrega}` : '']
    .filter(Boolean)
    .join(' ');
  if (withComp) wrapText(withComp, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (bairroEntrega) wrapText(`Bairro: ${bairroEntrega}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (deliveryReference) wrapText(`Ref.: ${deliveryReference}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (cidadeEntrega || cepEntrega) {
    const cidadeCep = [cidadeEntrega, cepEntrega ? `CEP: ${cepEntrega}` : ''].filter(Boolean).join(' | ');
    wrapText(cidadeCep, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  }
} else if (deliveryTypeLower === 'dine_in' && payload.identificadorMesaSenha) {
  pushLine('', 'normal');
  wrapText(`Mesa: ${payload.identificadorMesaSenha}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
} else if (deliveryTypeLower === 'pickup') {
  pushLine('', 'normal');
  wrapText('Cliente retira no estabelecimento', receiptWidth).forEach((l) => pushLine(l, 'normal'));
}

// PDV usa `usuario` = USUARIO_BALCAO: não exibir esse login como nome do cliente.
const isCounterUser = ['USUARIO_BALCAO'].includes(
  String(firstNonEmpty(payload.usuario?.nomeUsuario, payload.usuario?.username, payload.user?.username, '')).trim().toUpperCase()
);
function skipCounterPlaceholderName(value) {
  const t = String(value || '').trim();
  if (!t) return '';
  if (t.toUpperCase() === 'USUARIO_BALCAO') return '';
  return t;
}

// Dados do cliente (PDV: telefone do pedido antes do usuário balcão)
const clientPhone = isCounterUser
  ? firstNonEmpty(
      payload.telefoneEntrega,
      payload.shippingPhone,
      payload.usuario?.telefone,
      payload.user?.phone,
      payload.cliente?.telefone,
      payload.customer?.phone
    )
  : firstNonEmpty(
      payload.usuario?.telefone,
      payload.user?.phone,
      payload.telefoneEntrega,
      payload.shippingPhone,
      payload.cliente?.telefone,
      payload.customer?.phone
    );
const clientEmail = firstNonEmpty(payload.usuario?.email, payload.user?.email, payload.cliente?.email);
let clientName = firstNonEmpty(
  payload.nomeClienteAvulso,
  skipCounterPlaceholderName(payload.usuario?.nomeUsuario),
  skipCounterPlaceholderName(payload.usuario?.nome),
  skipCounterPlaceholderName(payload.usuario?.username),
  payload.user?.nome,
  payload.user?.username,
  payload.cliente?.nome,
  payload.customer?.name
);
if (!clientName) {
  clientName = firstNonEmpty(
    clientEmail ? clientEmail.split('@')[0] : '',
    clientPhone ? `Cliente (${String(clientPhone).replace(/\D/g, '').slice(-4) || clientPhone})` : '',
    '-'
  );
}
const totalOrders = firstNonEmpty(payload.totalPedidos, payload.usuario?.totalPedidos, payload.user?.totalPedidos);
const hasClientBlock = !!(
  payload.nomeClienteAvulso ||
  payload.usuario?.nomeUsuario ||
  payload.usuario?.nome ||
  payload.user?.username ||
  clientPhone ||
  clientEmail
);

// Linha de valor (rótulo à esquerda, valor à direita) alinhada à largura.
function moneyRow(label, value) {
  const valueStr = brl(value);
  const labelWidth = Math.max(1, receiptWidth - valueStr.length);
  return `${padRight(label, labelWidth)}${padLeft(valueStr, valueStr.length)}`;
}

// Dados do cliente
if (hasClientBlock) {
  pushLine('', 'normal');
  pushLine(sectionHeader('CLIENTE'), 'normal');
  wrapText(`Nome: ${clientName}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (clientPhone) wrapText(`Telefone: ${clientPhone}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (!isCounterUser && clientEmail) wrapText(`E-mail: ${clientEmail}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
  if (totalOrders) wrapText(`Pedidos: ${totalOrders}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));
}

// Itens
const itemDetailWidth = Math.max(18, receiptWidth - 1);
pushLine('', 'normal');
pushLine(sectionHeader('ITENS'), 'normal');

if (!items.length) {
  pushLine('Sem itens no payload', 'normal');
} else {
  items.forEach((item) => {
    const qty = getItemQty(item);
    const basePrice = getItemBasePrice(item);
    const additionalsTotal = getItemAdditionalsDetailed(item).reduce((acc, a) => acc + a.value * a.qty, 0);
    const unitTotal = basePrice + additionalsTotal;
    const lineTotal = unitTotal * qty;
    const itemName = resolveItemName(item);

    const priceStr = brl(lineTotal);
    const namePart = `(${qty}) ${itemName}`;
    const nameWidth = Math.max(6, receiptWidth - priceStr.length - 1);
    const nameLines = wrapText(namePart, nameWidth);
    if (!nameLines.length) nameLines.push(namePart.slice(0, nameWidth));
    nameLines.forEach((l, i) => {
      if (i === 0) {
        pushLine(`${padRight(l, receiptWidth - priceStr.length)}${priceStr}`, 'normal');
      } else {
        pushLine(l, 'normal');
      }
    });

    if (isCustomProduct(item)) pushLine('  Personalizado', 'normal');

    const flavors = parseItemFlavors(item);
    const complements = parseItemComplements(item);
    const additionals = parseItemAdditionals(item);
    if (flavors) {
      wrapText(`Sabor: ${flavors}`, itemDetailWidth).forEach((l) => pushLine(`  ${l}`, 'normal'));
    }
    if (complements) {
      wrapText(`Compl: ${complements}`, itemDetailWidth).forEach((l) => pushLine(`  ${l}`, 'normal'));
    }
    if (additionals) {
      wrapText(`Adic: ${additionals}`, itemDetailWidth).forEach((l) => pushLine(`  ${l}`, 'normal'));
    }

    const itemObs = extractItemObs(item);
    if (itemObs) {
      wrapText(`Obs: ${itemObs}`, itemDetailWidth).forEach((l) => pushLine(`  ${l}`, 'normal'));
    }
  });
}

// Observações do pedido
const orderNotes = firstNonEmpty(payload.observacoes, payload.notes);
if (orderNotes) {
  pushLine('', 'normal');
  pushLine(sectionHeader('OBSERVACOES'), 'normal');
  wrapText(orderNotes, receiptWidth).forEach((l) => pushLine(l, 'normal'));
}

// Pagamento
pushLine('', 'normal');
pushLine(sectionHeader('PAGAMENTO'), 'normal');
wrapText(`Forma de Pagamento: ${paymentMethod}`, receiptWidth).forEach((l) => pushLine(l, 'normal'));

if (isPixPayment) pushLine('>>> Pago via PIX - nao cobrar!', 'normal');
if (isCashOnDeliveryPayment) pushLine('>>> Dinheiro na entrega - cobrar!', 'normal');
if (isCardPayment) pushLine('>>> Cartao na entrega - cobrar!', 'normal');

if (isCashOnDeliveryPayment && payload.precisaTroco && payload.valorTroco) {
  const trocaPara = Number(payload.valorTroco || 0);
  pushLine(moneyRow('Pago com:', trocaPara), 'normal');
  pushLine(moneyRow('Troco:', trocaPara - total), 'normal');
}

// Totais
pushLine('', 'normal');
pushLine(divider('.'), 'normal');
pushLine(moneyRow('Subtotal:', subtotal), 'normal');
if (deliveryTypeLower === 'delivery') {
  pushLine(moneyRow('Taxa de entrega:', deliveryFee), 'normal');
}
pushLine(divider('.'), 'normal');
pushLine(moneyRow('TOTAL:', total), 'normal');
pushLine(divider('='), 'normal');

// Rodapé
pushLine('', 'normal');
pushLine(center('Obrigado pela preferencia!', receiptWidth), 'normal');
pushLine(center(storeName, receiptWidth), 'normal');
pushLine('', 'normal');
pushLine(center('Powered by MiraDelivery', receiptWidth), 'normal');
pushLine(center('miradelivery.com.br', receiptWidth), 'normal');
pushLine('', 'normal');
pushLine(divider('='), 'normal');

while (lineStyles.length < lines.length) {
  lineStyles.push('normal');
}

// ─── Impressão ───────────────────────────────────────────────────────────────

const content = lines.join('\n');

function saveMockTxt() {
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Cupom mock salvo em: ${filePath}`);
}

function parseTargetIpPort(target) {
  const parts = String(target || '').split(':');
  if (parts.length !== 2) return null;
  const host = parts[0]?.trim();
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function escPosFontPrefix(scale) {
  // Font B ~9pt; Font A ~10pt altura dupla; Font A altura+ largura dupla ~12pt
  if (scale === 'small') return Buffer.from([0x1b, 0x4d, 0x01, 0x1d, 0x21, 0x00]);
  if (scale === 'large') return Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x10]);
  return Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x10]);
}

function escPosLinePrefix(style, scale) {
  const alignCenter = Buffer.from([0x1b, 0x61, 0x01]);
  const alignLeft = Buffer.from([0x1b, 0x61, 0x00]);
  if (style === 'titleCenter') {
    return Buffer.concat([alignCenter, Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x22])]);
  }
  if (style === 'title') {
    return Buffer.concat([alignLeft, Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x22])]);
  }
  if (style === 'heading') {
    return Buffer.concat([alignLeft, Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x11])]);
  }
  if (style === 'itemTitle') {
    return Buffer.concat([alignLeft, Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x11])]);
  }
  if (style === 'itemPrice' || style === 'itemDetail') {
    return Buffer.concat([alignLeft, Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x01])]);
  }
  return Buffer.concat([alignLeft, escPosFontPrefix(scale)]);
}

function sendToNetworkEscPos(target, textLines, styles, scale) {
  return new Promise((resolve, reject) => {
    const targetParsed = parseTargetIpPort(target);
    if (!targetParsed) {
      reject(new Error('Destino da impressora invalido. Use formato IP:PORTA, ex: 192.168.0.55:9100'));
      return;
    }

    const { host, port } = targetParsed;
    const socket = new net.Socket();
    let settled = false;

    const finishOnce = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    socket.setTimeout(7000);

    socket.once('connect', () => {
      const init = Buffer.from([0x1b, 0x40]);
      const chunks = [init];
      for (let i = 0; i < textLines.length; i += 1) {
        const style = styles[i] || 'normal';
        chunks.push(escPosLinePrefix(style, scale));
        chunks.push(Buffer.from(`${textLines[i]}\n`, 'utf8'));
      }
      chunks.push(Buffer.from('\n\n', 'utf8'));
      const feedAndCut = Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]);
      chunks.push(feedAndCut);
      socket.write(Buffer.concat(chunks), (err) => {
        if (err) {
          finishOnce(reject, err);
          socket.destroy();
          return;
        }
        socket.end();
      });
    });

    socket.once('timeout', () => {
      finishOnce(reject, new Error('Timeout ao conectar na impressora de rede.'));
      socket.destroy();
    });

    socket.once('error', (err) => {
      finishOnce(reject, err);
    });

    socket.once('close', () => {
      finishOnce(resolve);
    });

    socket.connect(port, host);
  });
}

async function main() {
  if (printerType === 'windows_spooler') {
    if (!printerTarget) {
      throw new Error('Destino da impressora nao configurado para windows_spooler.');
    }

    const b64Content = Buffer.from(content, 'utf8').toString('base64');
    const b64LineStyles = Buffer.from(JSON.stringify(lineStyles), 'utf8').toString('base64');
    const b64Printer = Buffer.from(printerTarget, 'utf8').toString('base64');
    const b64FontScale = Buffer.from(fontScale, 'utf8').toString('base64');

    const psScript = `$ErrorActionPreference = 'Stop'
$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Content}'))
$lineStylesJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64LineStyles}'))
$wanted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Printer}'))
$fontScale = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64FontScale}'))
$receiptWidth = ${receiptWidth}
$receiptContentMm = ${receiptContentMm}
$paperWidthMm = ${paperWidthMm}
$receiptLineHeight = ${RECEIPT_LINE_HEIGHT}
$fontPtBody = ${RECEIPT_FONT_PT.body}
$fontPtMuted = ${RECEIPT_FONT_PT.muted}
$fontPtLarge = ${RECEIPT_FONT_PT.large}
$fontPtTitle = ${RECEIPT_FONT_PT.title}
$fontPtHeading = ${RECEIPT_FONT_PT.heading}
$fontPtItemTitle = ${RECEIPT_FONT_PT.itemTitle}
$fontPtItemPrice = ${RECEIPT_FONT_PT.itemPrice}
$fontPtItemDetail = ${RECEIPT_FONT_PT.itemDetail}
function Resolve-MiraPrinter([string]$name) {
  $all = @(Get-Printer | Select-Object -ExpandProperty Name)
  if ($all -contains $name) { return $name }
  foreach ($p in $all) {
    if ($p.Equals($name, [System.StringComparison]::OrdinalIgnoreCase)) { return $p }
  }
  foreach ($p in $all) {
    if ($p -like ('*' + $name + '*')) { return $p }
    if ($name -like ('*' + $p + '*')) { return $p }
  }
  return $null
}
$printerName = Resolve-MiraPrinter $wanted
if (-not $printerName) {
  $available = (Get-Printer | Select-Object -ExpandProperty Name) -join ', '
  Write-Error ("Impressora nao encontrada. Configurado: " + $wanted + ". Instaladas: " + $available)
  exit 2
}
Add-Type -AssemblyName System.Drawing

function New-MiraMonoFont([float]$size) {
  try {
    return New-Object System.Drawing.Font('Courier New', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  } catch {
    return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericMonospace, $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  }
}

function Resolve-MiraFont([System.Drawing.Graphics]$graphics, [float]$maxWidth, [int]$cols, [string]$scale) {
  $size = [float]$fontPtBody
  if ($scale -eq 'small') { $size = [float]$fontPtMuted }
  if ($scale -eq 'large') { $size = [float]$fontPtLarge }

  $sf = [System.Drawing.StringFormat]::GenericTypographic
  $sample = 'W' * [Math]::Max(1, $cols)
  while ($size -gt 4.5) {
    $font = New-MiraMonoFont $size
    $measured = $graphics.MeasureString($sample, $font, 4096, $sf).Width
    if ($measured -le $maxWidth) { return $font }
    $font.Dispose()
    $size = $size - 0.25
  }

  return New-MiraMonoFont $size
}

function Resolve-MiraStyledFont([System.Drawing.Graphics]$graphics, [float]$maxWidth, [string]$lineStyle, [string]$text) {
  $size = [float]$fontPtBody
  if ($lineStyle -eq 'title' -or $lineStyle -eq 'titleCenter') { $size = [float]$fontPtTitle }
  elseif ($lineStyle -eq 'heading') { $size = [float]$fontPtHeading }
  elseif ($lineStyle -eq 'itemTitle') { $size = [float]$fontPtItemTitle }
  elseif ($lineStyle -eq 'itemPrice') { $size = [float]$fontPtItemPrice }
  elseif ($lineStyle -eq 'itemDetail') { $size = [float]$fontPtItemDetail }

  $sf = [System.Drawing.StringFormat]::GenericTypographic
  while ($size -gt 4.5) {
    $font = New-MiraMonoFont $size
    $measured = $graphics.MeasureString($text, $font, 4096, $sf).Width
    if ($measured -le $maxWidth) { return $font }
    $font.Dispose()
    $size = $size - 0.25
  }

  return New-MiraMonoFont $size
}

$script:miraLines = $content -split '\\r?\\n'
$script:miraLineStyles = @($lineStylesJson | ConvertFrom-Json)
$script:miraLineIndex = 0
$script:miraNormalFont = $null
$script:miraFontCache = @{}
$script:miraReceiptWidth = [Math]::Max(1, $receiptWidth)
$script:miraFontScale = $fontScale
$script:miraContentWidth = 0.0

$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $printerName
$doc.DocumentName = 'Mira Pedido'
$doc.OriginAtMargins = $false
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
if ($paperWidthMm -gt 0) {
  $paperWidth = [int][Math]::Round(($paperWidthMm / 25.4) * 100)
  $doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('Mira Roll', $paperWidth, 1200)
}

$doc.add_PrintPage({
  param($sender, $event)

  $printable = $event.PageSettings.PrintableArea
  $maxWidth = $printable.Width
  if ($maxWidth -le 0) { $maxWidth = $event.PageBounds.Width }

  if ($script:miraNormalFont -eq $null) {
    $paperW = [float][Math]::Max(1, $maxWidth)
    $contentRatio = [float]$receiptContentMm / [float][Math]::Max(1, $paperWidthMm)
    $script:miraContentWidth = $paperW * $contentRatio
    $usableWidth = $script:miraContentWidth * 0.98
    $script:miraNormalFont = Resolve-MiraFont $event.Graphics $usableWidth $script:miraReceiptWidth $script:miraFontScale
  }

  $paperW = [float][Math]::Max(1, $maxWidth)
  $x = [Math]::Max(0, $printable.Left) + (($paperW - $script:miraContentWidth) / 2.0)
  $y = [Math]::Max(0, $printable.Top)
  $maxY = $printable.Bottom
  if ($maxY -le 0) { $maxY = $event.PageBounds.Bottom }
  $drawSf = [System.Drawing.StringFormat]::GenericTypographic
  $usableLineWidth = $script:miraContentWidth * 0.98

  while ($script:miraLineIndex -lt $script:miraLines.Length) {
    $lineText = $script:miraLines[$script:miraLineIndex]
    $lineStyle = 'normal'
    if ($script:miraLineIndex -lt $script:miraLineStyles.Length) {
      $lineStyle = [string]$script:miraLineStyles[$script:miraLineIndex]
      if ([string]::IsNullOrWhiteSpace($lineStyle)) { $lineStyle = 'normal' }
    }

    if ($lineStyle -eq 'normal') {
      $lineFont = $script:miraNormalFont
    } else {
      $cacheKey = $lineStyle + '|' + $lineText
      if (-not $script:miraFontCache.ContainsKey($cacheKey)) {
        $script:miraFontCache[$cacheKey] = Resolve-MiraStyledFont $event.Graphics $usableLineWidth $lineStyle $lineText
      }
      $lineFont = $script:miraFontCache[$cacheKey]
    }

    $lineHeight = $lineFont.GetHeight($event.Graphics) * $receiptLineHeight
    if (($y + $lineHeight) -gt $maxY) {
      $event.HasMorePages = $true
      return
    }

    $drawX = $x
    if ($lineStyle -eq 'titleCenter') {
      $measured = $event.Graphics.MeasureString($lineText, $lineFont, 4096, $drawSf).Width
      $offset = ($script:miraContentWidth - $measured) / 2.0
      if ($offset -gt 0) { $drawX = $x + $offset }
    }

    $event.Graphics.DrawString($lineText, $lineFont, [System.Drawing.Brushes]::Black, $drawX, $y, $drawSf)
    $y = $y + $lineHeight
    $script:miraLineIndex = $script:miraLineIndex + 1
  }

  $event.HasMorePages = $false
})

$doc.Print()
if ($script:miraNormalFont -ne $null) { $script:miraNormalFont.Dispose() }
foreach ($cachedFont in $script:miraFontCache.Values) {
  if ($cachedFont -ne $null) { $cachedFont.Dispose() }
}
$doc.Dispose()
`;

    const tmpPs1 = path.join(os.tmpdir(), `mira-auto-print-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(tmpPs1, '\ufeff' + psScript, 'utf8');

    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });

      const cleanup = () => {
        try {
          fs.unlinkSync(tmpPs1);
        } catch (_) {}
      };

      child.on('error', (err) => {
        cleanup();
        reject(err);
      });
      child.on('exit', (code) => {
        cleanup();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `PowerShell finalizou com codigo ${code}`));
        }
      });
    });

    console.log(`Cupom enviado para impressora Windows (resolvida para nome instalado).`);
    return;
  }

  if (printerType === 'network_escpos') {
    if (!printerTarget) {
      throw new Error('Destino da impressora nao configurado para network_escpos.');
    }
    await sendToNetworkEscPos(printerTarget, lines, lineStyles, fontScale);
    console.log(`Cupom enviado para impressora de rede ${printerTarget}`);
    return;
  }

  // fallback/default: modo mock em arquivo .txt
  saveMockTxt();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Falha na autoimpressao: ${err.message}`);
    process.exit(1);
  });