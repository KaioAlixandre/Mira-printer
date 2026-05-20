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

function resolveItemName(item) {
  const snap = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
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

  const snapshot = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
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

  const snapshot = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
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

  const snapshot = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
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

function resolveReceiptWidth(widthMm) {
  const width = Number(widthMm);
  if (!Number.isFinite(width) || width <= 0) return 48;
  return width >= 76 ? 48 : 32;
}

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
  const snap = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
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
  const snap = parseOptionsSnapshot(item?.opcoesSelecionadas || item?.opcoesSelecionadasSnapshot);
  return !!(snap?.customAcai || snap?.customSorvete || snap?.customProduct);
}

// ─── Montagem do cupom ───────────────────────────────────────────────────────

const lines = [];

// Cabeçalho
lines.push(divider('='));
lines.push(center(storeName, receiptWidth));
const storeAddress = resolveStoreAddress(payload);
if (storeAddress) lines.push(center(storeAddress, receiptWidth));
lines.push(divider('='));
lines.push('');

// Número e data do pedido
const orderNumber = `PEDIDO #${payload.dailyNumber || payload.id}`;
lines.push(center(orderNumber, receiptWidth));
lines.push(center(formatDate(payload.criadoEm || payload.createdAt), receiptWidth));
lines.push('');

// Tipo de entrega
lines.push(center('------------ TIPO DE ENTREGA ------------', receiptWidth));

const deliveryLabel = formatDeliveryType(deliveryTypeRaw);
lines.push(center(deliveryLabel, receiptWidth));

if (String(deliveryTypeRaw).toLowerCase() === 'delivery') {
  lines.push('');
  const streetLine = [payload.ruaEntrega, payload.numeroEntrega].filter(Boolean).join(', ');
  const withComp = [streetLine, payload.complementoEntrega ? `Comp: ${payload.complementoEntrega}` : '']
    .filter(Boolean)
    .join(' ');
  if (withComp) wrapText(withComp, receiptWidth).forEach((l) => lines.push(l));
  if (payload.bairroEntrega) wrapText(`Bairro: ${payload.bairroEntrega}`, receiptWidth).forEach((l) => lines.push(l));
  const deliveryReference = getDeliveryReference(payload);
  if (deliveryReference) wrapText(`Ref.: ${deliveryReference}`, receiptWidth).forEach((l) => lines.push(l));
}
if (String(deliveryTypeRaw).toLowerCase() === 'dine_in' && payload.identificadorMesaSenha) {
  wrapText(`Mesa: ${payload.identificadorMesaSenha}`, receiptWidth).forEach((l) => lines.push(l));
}
if (String(deliveryTypeRaw).toLowerCase() === 'pickup') {
  wrapText('Cliente retira no estabelecimento', receiptWidth).forEach((l) => lines.push(l));
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

if (hasClientBlock) {
  lines.push('');
  lines.push(center('--------------- CLIENTE ---------------', receiptWidth));
  lines.push(`Nome   : ${clientName}`);
  if (clientPhone) lines.push(`Fone   : ${clientPhone}`);
  if (!isCounterUser && clientEmail) lines.push(`E-mail : ${clientEmail}`);
  if (totalOrders) lines.push(`Pedidos: ${totalOrders}`);
}

// Itens
lines.push('');
lines.push(center('---------------- ITENS ----------------', receiptWidth));

// Cabeçalho da tabela de itens
const descWidth = receiptWidth - 1 - 10 - 10;
lines.push(`${padRight('Descricao', descWidth)} ${padLeft('Unit.', 10)}${padLeft('Total', 10)}`);
lines.push(divider('.'));

if (!items.length) {
  lines.push('  Sem itens no payload');
} else {
  items.forEach((item, idx) => {
    const qty = getItemQty(item);
    const basePrice = getItemBasePrice(item);
    const additionalsTotal = getItemAdditionalsDetailed(item).reduce((acc, a) => acc + a.value * a.qty, 0);
    const unitTotal = basePrice + additionalsTotal;
    const lineTotal = unitTotal * qty;
    const itemName = resolveItemName(item);

    // Linha principal do item: "2x Produto" + valores
    const itemTitle = `${qty}x ${itemName}`;
    const titleLines = wrapText(itemTitle, descWidth);
    lines.push(`${padRight(titleLines[0] || '', descWidth)} ${padLeft(brl(unitTotal), 10)}${padLeft(brl(lineTotal), 10)}`);
    titleLines.slice(1).forEach((l) => lines.push(l));
    if (isCustomProduct(item)) lines.push('  > Personalizado');

    // Sabores, complementos e adicionais com recuo
    const flavors = parseItemFlavors(item);
    const complements = parseItemComplements(item);
    const additionals = parseItemAdditionals(item);
    if (flavors)      wrapText(`  Sabor: ${flavors}`, receiptWidth).forEach((l) => lines.push(l));
    if (complements)  wrapText(`  Compl: ${complements}`, receiptWidth).forEach((l) => lines.push(l));
    if (additionals)  wrapText(`  Adic : ${additionals}`, receiptWidth).forEach((l) => lines.push(l));

    const itemObs = extractItemObs(item);
    if (itemObs) wrapText(`  Obs  : ${itemObs}`, receiptWidth).forEach((l) => lines.push(l));

    // Separador leve entre itens (exceto último)
    if (idx < items.length - 1) lines.push(divider('.'));
  });
}

// Observações do pedido
const orderNotes = firstNonEmpty(payload.observacoes, payload.notes);
if (orderNotes) {
  lines.push('');
  lines.push(center('-------------- OBSERVACOES --------------', receiptWidth));
  wrapText(orderNotes, receiptWidth).forEach((l) => lines.push(l));
}

// Pagamento e totais
lines.push('');
lines.push(center('-------------- PAGAMENTO --------------', receiptWidth));

lines.push(`Forma   : ${paymentMethod}`);

if (isPixPayment)          lines.push('>>> Pago via PIX - nao cobrar! <<<');
if (isCashOnDeliveryPayment) lines.push('>>> Dinheiro na entrega - cobrar! <<<');
if (isCardPayment)         lines.push('>>> Cartao na entrega - cobrar! <<<');

if (isCashOnDeliveryPayment && payload.precisaTroco && payload.valorTroco) {
  const trocaPara = Number(payload.valorTroco || 0);
  lines.push(`Pago com: ${brl(trocaPara)}`);
  lines.push(`Troco   : ${brl(trocaPara - total)}`);
}

lines.push('');
lines.push(divider('.'));
lines.push(`${padRight('Subtotal', receiptWidth - 12)}${padLeft(brl(subtotal), 12)}`);
if (String(deliveryTypeRaw).toLowerCase() === 'delivery') {
  lines.push(`${padRight('Entrega', receiptWidth - 12)}${padLeft(brl(deliveryFee), 12)}`);
}
lines.push(divider('.'));
lines.push(`${padRight('TOTAL', receiptWidth - 12)}${padLeft(brl(total), 12)}`);
lines.push(divider('='));

// Rodapé
lines.push('');
lines.push(center('Obrigado pela preferencia!', receiptWidth));
lines.push(center(storeName, receiptWidth));
lines.push('');
lines.push(center('Powered by MiraDelivery', receiptWidth));
lines.push(center('miradelivery.com.br', receiptWidth));
lines.push('');
lines.push(divider('='));

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
  if (scale === 'small') return Buffer.from([0x1b, 0x4d, 0x01, 0x1d, 0x21, 0x00]);
  if (scale === 'large') return Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x11]);
  return Buffer.from([0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x00]);
}

function sendToNetworkEscPos(target, text, scale) {
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
      // ESC/POS: init + texto + feed + corte parcial
      const init = Buffer.from([0x1b, 0x40]);
      const font = escPosFontPrefix(scale);
      const textBuffer = Buffer.from(`${text}\n`, 'utf8');
      const feedAndCut = Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]);
      const full = Buffer.concat([init, font, textBuffer, feedAndCut]);
      socket.write(full, (err) => {
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
    const b64Printer = Buffer.from(printerTarget, 'utf8').toString('base64');
    const b64FontScale = Buffer.from(fontScale, 'utf8').toString('base64');

    const psScript = `$ErrorActionPreference = 'Stop'
$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Content}'))
$wanted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Printer}'))
$fontScale = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64FontScale}'))
$receiptWidth = ${receiptWidth}
$paperWidthMm = ${paperWidthMm}
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
    return New-Object System.Drawing.Font('Consolas', $size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  } catch {
    return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericMonospace, $size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  }
}

function Resolve-MiraFont([System.Drawing.Graphics]$graphics, [float]$maxWidth, [int]$cols, [string]$scale) {
  $size = 8.0
  if ($scale -eq 'small') { $size = 7.0 }
  if ($scale -eq 'large') { $size = 10.0 }

  # GenericTypographic: medicao alinhada ao DrawString sem padding extra do GDI;
  # sem isso a fonte passa de ~1 coluna na largura util e a borda direita corta o ultimo caractere (ex.: "Total" -> "Tota").
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

$script:miraLines = $content -split '\\r?\\n'
$script:miraLineIndex = 0
$script:miraFont = $null
$script:miraReceiptWidth = [Math]::Max(1, $receiptWidth)
$script:miraFontScale = $fontScale

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

  if ($script:miraFont -eq $null) {
    # Margem fisica da impressora + pequena diferenca PrintableArea vs largura real: evita clip na ultima coluna.
    $usableWidth = [float]([Math]::Max(1, $maxWidth) * 0.97)
    $script:miraFont = Resolve-MiraFont $event.Graphics $usableWidth $script:miraReceiptWidth $script:miraFontScale
  }

  $x = [Math]::Max(0, $printable.Left)
  $y = [Math]::Max(0, $printable.Top)
  $maxY = $printable.Bottom
  if ($maxY -le 0) { $maxY = $event.PageBounds.Bottom }
  $lineHeight = $script:miraFont.GetHeight($event.Graphics)
  $drawSf = [System.Drawing.StringFormat]::GenericTypographic

  while ($script:miraLineIndex -lt $script:miraLines.Length) {
    if (($y + $lineHeight) -gt $maxY) {
      $event.HasMorePages = $true
      return
    }

    $event.Graphics.DrawString($script:miraLines[$script:miraLineIndex], $script:miraFont, [System.Drawing.Brushes]::Black, $x, $y, $drawSf)
    $y = $y + $lineHeight
    $script:miraLineIndex = $script:miraLineIndex + 1
  }

  $event.HasMorePages = $false
})

$doc.Print()
if ($script:miraFont -ne $null) { $script:miraFont.Dispose() }
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
    await sendToNetworkEscPos(printerTarget, content, fontScale);
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