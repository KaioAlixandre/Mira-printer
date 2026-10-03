/*
  Imprime o cupom de conferência da mesa (todos os pedidos em um único cupom).
  Payload: AUTO_PRINT_ORDER_JSON com kind = 'mesa_conferencia' e campo conferencia.
*/

const fs = require('fs');
const { loadPrintEnv, printReceipt } = require('./print_receipt_output');

function parsePayload() {
  const filePath = String(process.env.AUTO_PRINT_ORDER_JSON_FILE || '').trim();
  if (filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
const conferencia =
  payload?.conferencia && typeof payload.conferencia === 'object'
    ? payload.conferencia
    : payload;

if (!conferencia || typeof conferencia !== 'object') {
  console.error('AUTO_PRINT_ORDER_JSON ausente ou inválido para conferência de mesa.');
  process.exit(1);
}

const env = loadPrintEnv(conferencia.__autoPrintConfig || payload?.__autoPrintConfig || {});
const receiptWidth = env.receiptWidth;

function brl(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

function formatDate(dateValue) {
  if (!dateValue) return '-';
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function padRight(value, width) {
  const s = String(value ?? '');
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
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
  return row.length > width
    ? `${left.slice(0, Math.max(0, width - amount.length - 1))} ${amount}`.slice(0, width)
    : row;
}

const lines = [];
const lineStyles = [];

function pushLine(text, style = 'normal') {
  lines.push(text);
  lineStyles.push(style);
}

const storeName =
  conferencia.nomeLoja ||
  conferencia.loja?.nome ||
  payload?.nomeLoja ||
  payload?.loja?.nome ||
  process.env.STORE_NAME ||
  'MIRA DELIVERY';

const mesaNome = String(conferencia.mesaNome || conferencia.nome || 'Mesa').trim() || 'Mesa';
const mesaIdentificador = String(conferencia.mesaIdentificador || '').trim();
const clientes = Array.isArray(conferencia.clientes) ? conferencia.clientes : [];
const subtotal = Number(conferencia.subtotal ?? 0);
const total = Number(conferencia.total ?? subtotal);
const ajuste = conferencia.ajuste && typeof conferencia.ajuste === 'object' ? conferencia.ajuste : null;
const itemDetailWidth = Math.max(18, receiptWidth - 1);

pushLine(divider('='), 'normal');
pushLine(center(String(storeName).toUpperCase(), receiptWidth), 'heading');
pushLine(center('CONFERENCIA DE MESA', receiptWidth), 'titleCenter');
pushLine(divider('='), 'normal');
pushLine('', 'normal');

wrapText(`Mesa: ${mesaNome}`, receiptWidth).forEach((l) => pushLine(l, 'heading'));
if (mesaIdentificador && mesaIdentificador.toLowerCase() !== mesaNome.toLowerCase()) {
  wrapText(mesaIdentificador, receiptWidth).forEach((l) => pushLine(l, 'itemDetail'));
}
pushLine(formatDate(conferencia.impressoEm || new Date().toISOString()), 'itemDetail');
pushLine('', 'normal');

if (!clientes.length) {
  pushLine(center('Sem pedidos na mesa', receiptWidth), 'normal');
} else {
  clientes.forEach((cliente, clienteIdx) => {
    const nomeCliente = String(cliente?.nome || 'Cliente').trim() || 'Cliente';
    const pedidos = Array.isArray(cliente?.pedidos) ? cliente.pedidos : [];

    if (clienteIdx > 0) pushLine('', 'normal');
    pushLine(divider('-'), 'normal');
    wrapText(`Cliente: ${nomeCliente}`, receiptWidth).forEach((l) => pushLine(l, 'heading'));
    pushLine(divider('-'), 'normal');

    pedidos.forEach((pedido, pedidoIdx) => {
      const num = pedido?.dailyNumber ?? pedido?.id ?? '?';
      const pedidoSubtotal = Number(pedido?.subtotal ?? 0);
      const items = Array.isArray(pedido?.items) ? pedido.items : [];

      if (pedidoIdx > 0) pushLine('', 'normal');
      pushLine(`Pedido #${num}`, 'normal');
      if (pedido?.createdAt) {
        pushLine(formatDate(pedido.createdAt), 'itemDetail');
      }

      if (!items.length) {
        pushLine('  Sem itens', 'itemDetail');
      } else {
        items.forEach((item) => {
          const qtyLabel = String(item.quantityLabel || item.quantity || 1).trim();
          const name = String(item.name || 'Item').trim() || 'Item';
          const lineTotal = Number(item.total ?? Number(item.unitPrice || 0) * Number(item.quantity || 1));
          const priceStr = brl(lineTotal);
          const namePart = `(${qtyLabel}) ${name}`;
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

          if (item.flavors) {
            wrapText(`Sabor: ${item.flavors}`, itemDetailWidth).forEach((l) =>
              pushLine(`  ${l}`, 'itemDetail')
            );
          }
          if (item.complements) {
            wrapText(`Compl: ${item.complements}`, itemDetailWidth).forEach((l) =>
              pushLine(`  ${l}`, 'itemDetail')
            );
          }
          if (item.additionals) {
            wrapText(`Adic: ${item.additionals}`, itemDetailWidth).forEach((l) =>
              pushLine(`  ${l}`, 'itemDetail')
            );
          }
          if (item.observacao) {
            wrapText(`Obs: ${item.observacao}`, itemDetailWidth).forEach((l) =>
              pushLine(`  ${l}`, 'itemDetail')
            );
          }
        });
      }

      const notes = String(pedido?.notes || '').trim();
      if (notes) {
        wrapText(`Obs pedido: ${notes}`, itemDetailWidth).forEach((l) =>
          pushLine(`  ${l}`, 'itemDetail')
        );
      }

      pushLine(moneyRow(`Subtotal #${num}`, pedidoSubtotal), 'itemDetail');
    });
  });
}

pushLine('', 'normal');
pushLine(divider('='), 'normal');
pushLine(center('TOTAIS', receiptWidth), 'heading');
pushLine(divider('-'), 'normal');
pushLine(moneyRow('Subtotal', subtotal), 'normal');
if (ajuste && Number(ajuste.valor) > 0) {
  const ajusteLabel =
    String(ajuste.label || (ajuste.tipo === 'desconto' ? 'Desconto' : 'Acrescimo')).trim() ||
    (ajuste.tipo === 'desconto' ? 'Desconto' : 'Acrescimo');
  const signed = ajuste.tipo === 'desconto' ? -Math.abs(Number(ajuste.valor)) : Number(ajuste.valor);
  pushLine(moneyRow(ajusteLabel, signed), 'normal');
}
pushLine(moneyRow('TOTAL', total), 'itemPrice');
pushLine(divider('='), 'normal');
pushLine('', 'normal');
pushLine(center('Conferencia da mesa', receiptWidth), 'normal');
pushLine(center('Mira Delivery', receiptWidth), 'itemDetail');
pushLine(divider('='), 'normal');
pushLine('', 'normal');
pushLine('', 'normal');

printReceipt({
  lines,
  lineStyles,
  documentName: 'Mira Conferencia Mesa',
  filePrefix: `conferencia_${conferencia.id || mesaNome || Date.now()}`,
  printCfg: conferencia.__autoPrintConfig || payload?.__autoPrintConfig || {},
})
  .then(() => {
    console.log(`Conferencia da mesa ${mesaNome} enviada para impressao.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Falha ao imprimir conferencia de mesa: ${err.message}`);
    process.exit(1);
  });
