/*
  Imprime o cupom de fechamento de caixa.
  Payload: AUTO_PRINT_ORDER_JSON com kind = 'caixa_fechamento'.
*/

const fs = require('fs');
const { loadPrintEnv, printReceipt } = require('./print_receipt_output');

function parsePayload() {
  const filePath = String(
    process.env.AUTO_PRINT_ORDER_JSON_FILE || process.env.AUTO_PRINT_ORDER_JSON_FILE || ''
  ).trim();
  if (filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  const raw = process.env.AUTO_PRINT_ORDER_JSON || process.env.AUTO_PRINT_ORDER_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const payload = parsePayload();
const caixa = payload?.caixa && typeof payload.caixa === 'object' ? payload.caixa : payload;

if (!caixa || typeof caixa !== 'object') {
  console.error('AUTO_PRINT_ORDER_JSON ausente ou inválido para fechamento de caixa.');
  process.exit(1);
}

const env = loadPrintEnv(caixa.__autoPrintConfig || payload?.__autoPrintConfig || {});
const receiptWidth = env.receiptWidth;

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
  return ' '.repeat(left) + s + ' '.repeat(totalPad - left);
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

function moneyRow(label, value, width = receiptWidth) {
  const amount = brl(value);
  const left = String(label || '');
  const space = Math.max(1, width - left.length - amount.length);
  const row = left + ' '.repeat(space) + amount;
  return row.length > width ? `${left.slice(0, Math.max(0, width - amount.length - 1))} ${amount}`.slice(0, width) : row;
}

function countRow(label, count, width = receiptWidth) {
  const right = String(count);
  const left = String(label || '');
  const space = Math.max(1, width - left.length - right.length);
  return (left + ' '.repeat(space) + right).slice(0, width);
}

const lines = [];
const lineStyles = [];

function pushLine(text, style = 'normal') {
  lines.push(text);
  lineStyles.push(style);
}

const storeName =
  caixa.nomeLoja ||
  caixa.loja?.nome ||
  payload?.nomeLoja ||
  payload?.loja?.nome ||
  process.env.STORE_NAME ||
  'MIRA DELIVERY';

const openedAt = caixa.abertoEm || caixa.openedAt || payload?.abertoEm;
const closedAt = caixa.fechadoEm || caixa.closedAt || payload?.fechadoEm || new Date().toISOString();
const valorInicial = Number(caixa.valorInicial ?? 0);
const valorFinal = Number(caixa.valorFinal ?? 0);
const valorEsperado = Number(caixa.valorEsperado ?? 0);
const diferenca = Number(caixa.diferenca ?? valorFinal - valorEsperado);
const totalVendas = Number(caixa.totalVendas ?? 0);
const totalDinheiro = Number(caixa.totalDinheiro ?? 0);
const totalPix = Number(caixa.totalPix ?? 0);
const totalCartao = Number(caixa.totalCartao ?? 0);
const totalSangrias = Number(caixa.totalSangrias ?? 0);
const totalPedidos = Number(caixa.totalPedidos ?? 0);
const ticketMedio = Number(caixa.ticketMedio ?? (totalPedidos > 0 ? totalVendas / totalPedidos : 0));
const sangrias = Array.isArray(caixa.sangrias) ? caixa.sangrias : [];
const pagamentos = Array.isArray(caixa.pagamentos) && caixa.pagamentos.length
  ? caixa.pagamentos
  : [
      { method: 'CASH_ON_DELIVERY', label: 'Dinheiro', total: totalDinheiro, count: 0 },
      { method: 'PIX', label: 'PIX', total: totalPix, count: 0 },
      { method: 'CREDIT_CARD', label: 'Cartao', total: totalCartao, count: 0 },
    ];

const bateu = Math.abs(diferenca) < 0.01;

pushLine(divider('='), 'normal');
pushLine(center(String(storeName).toUpperCase(), receiptWidth), 'heading');
pushLine(center('FECHAMENTO DE CAIXA', receiptWidth), 'titleCenter');
pushLine(divider('='), 'normal');
pushLine('', 'normal');
pushLine(padRight('Abertura', 12) + formatDate(openedAt), 'itemDetail');
pushLine(padRight('Fechamento', 12) + formatDate(closedAt), 'itemDetail');
pushLine('', 'normal');

pushLine(center('RESUMO', receiptWidth), 'heading');
pushLine(divider('-'), 'normal');
pushLine(countRow('Pedidos', totalPedidos), 'normal');
pushLine(moneyRow('Ticket medio', ticketMedio), 'normal');
pushLine(moneyRow('Total vendas', totalVendas), 'itemPrice');
pushLine('', 'normal');

pushLine(center('PAGAMENTOS', receiptWidth), 'heading');
pushLine(divider('-'), 'normal');
pagamentos.forEach((p) => {
  const label = `${p.label || p.method || 'Pagamento'}${p.count ? ` (${p.count})` : ''}`;
  pushLine(moneyRow(label, p.total), 'normal');
});
pushLine('', 'normal');

pushLine(center('CONFERENCIA', receiptWidth), 'heading');
pushLine(divider('-'), 'normal');
pushLine(moneyRow('Fundo inicial', valorInicial), 'normal');
pushLine(moneyRow('Vendas dinheiro', totalDinheiro), 'normal');
if (totalSangrias > 0) {
  pushLine(moneyRow('Sangrias', -Math.abs(totalSangrias)), 'itemDetail');
}
pushLine(moneyRow('Valor esperado', valorEsperado), 'itemPrice');
pushLine(moneyRow('Valor informado', valorFinal), 'itemPrice');
pushLine(divider('-'), 'normal');
pushLine(moneyRow('Diferenca', diferenca), bateu ? 'normal' : 'heading');
pushLine(center(bateu ? 'CAIXA BATEU' : 'DIFERENCA ENCONTRADA', receiptWidth), bateu ? 'heading' : 'titleCenter');
pushLine('', 'normal');

if (sangrias.length > 0) {
  pushLine(center('SANGRIAS', receiptWidth), 'heading');
  pushLine(divider('-'), 'normal');
  sangrias.forEach((s) => {
    const when = s.data || s.criadoEm || s.createdAt || '';
    pushLine(moneyRow(formatDate(when), s.valor), 'normal');
    const note = String(s.observacao || s.note || '').trim();
    if (note) {
      wrapText(note, receiptWidth).forEach((l) => pushLine(l, 'itemDetail'));
    }
  });
  pushLine(moneyRow('Total sangrias', totalSangrias || sangrias.reduce((acc, s) => acc + Number(s.valor || 0), 0)), 'itemPrice');
  pushLine('', 'normal');
}

pushLine(divider('='), 'normal');
pushLine(center('Caixa encerrado', receiptWidth), 'normal');
pushLine(center('Mira Delivery', receiptWidth), 'itemDetail');
pushLine(divider('='), 'normal');
pushLine('', 'normal');
pushLine('', 'normal');

printReceipt({
  lines,
  lineStyles,
  documentName: 'Mira Fechamento Caixa',
  filePrefix: `caixa_${caixa.id || Date.now()}`,
  printCfg: caixa.__autoPrintConfig || payload?.__autoPrintConfig || {},
})
  .then(() => {
    console.log(`Fechamento de caixa ${caixa.id || ''} enviado para impressao.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Falha ao imprimir fechamento de caixa: ${err.message}`);
    process.exit(1);
  });
