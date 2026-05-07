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

const printsDir = path.resolve(__dirname, '..', 'prints');
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
    const text = String(value).trim();
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
  return firstNonEmpty(
    item?.produto?.nome,
    item?.produto?.name,
    item?.nomeProduto,
    item?.produtoNome,
    item?.nome,
    item?.name,
    'Produto'
  );
}

function parseItemAdditionals(item) {
  const additionalParts = [];
  const pushAdditional = (qtyRaw, nameRaw, valueRaw) => {
    const name = firstNonEmpty(nameRaw, 'Adicional');
    const qty = Number(qtyRaw || 1);
    const value = Number(valueRaw || 0);
    additionalParts.push(`${qty}x ${name} (+${brl(value)})`);
  };

  const additionals = Array.isArray(item?.adicionais) ? item.adicionais : [];
  additionals.forEach((a) => {
    pushAdditional(
      a?.quantidade,
      firstNonEmpty(a?.adicional?.nome, a?.adicional?.name, a?.nome, a?.name),
      a?.adicional?.preco ?? a?.preco
    );
  });

  const itemPedidoAdicionais = Array.isArray(item?.item_pedido_adicionais) ? item.item_pedido_adicionais : [];
  itemPedidoAdicionais.forEach((a) => {
    pushAdditional(
      a?.quantidade,
      firstNonEmpty(a?.adicional?.nome, a?.adicional?.name, a?.nome, a?.name),
      a?.adicional?.preco ?? a?.preco
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
      a?.preco ?? a?.price ?? 0
    );
  });

  return additionalParts.join(' | ');
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

const items = Array.isArray(payload.itens_pedido) ? payload.itens_pedido : [];
const subtotal = items.reduce((sum, item) => {
  const qty = Number(item.quantidade || 0);
  const basePrice = Number(item.precoNoPedido || 0);
  const additionalsTotal = (Array.isArray(item.adicionais) ? item.adicionais : []).reduce(
    (acc, a) => acc + Number(a.adicional?.preco || 0) * Number(a.quantidade || 0),
    0
  );
  const unitTotal = basePrice + additionalsTotal;
  return sum + unitTotal * qty;
}, 0);

const deliveryFee = Number(payload.taxaEntrega || 0);
const total = Number(payload.precoTotal || 0);
const paymentMethodRaw = payload.metodoPagamento || payload.pagamento?.metodo || '';
const paymentMethod = formatPaymentMethod(paymentMethodRaw);
const isPixPayment = String(paymentMethodRaw).toUpperCase() === 'PIX';
const isCashOnDeliveryPayment = String(paymentMethodRaw).toUpperCase() === 'CASH_ON_DELIVERY';
const isCardPayment = ['CREDIT_CARD', 'DEBIT_CARD'].includes(String(paymentMethodRaw).toUpperCase());
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
const receiptWidth = 40;

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

function wrapText(text, width) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const out = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
    } else {
      if (line) out.push(line);
      line = word;
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

const lines = [];
lines.push(storeName);
const storeAddress = resolveStoreAddress(payload);
if (storeAddress) lines.push(storeAddress);
lines.push(`#${payload.dailyNumber || payload.id} ${formatDate(payload.criadoEm)}`);
lines.push('');
lines.push('TIPO DE ENTREGA');
lines.push(formatDeliveryType(payload.tipoEntrega));
if (String(payload.tipoEntrega || '').toLowerCase() === 'delivery') {
  const streetLine = [payload.ruaEntrega, payload.numeroEntrega].filter(Boolean).join(', ');
  const withComp = [streetLine, payload.complementoEntrega ? `- ${payload.complementoEntrega}` : '']
    .filter(Boolean)
    .join(' ');
  if (withComp) lines.push(withComp);
  if (payload.bairroEntrega) lines.push(payload.bairroEntrega);
  if (payload.referenciaEntrega) lines.push(`Ref.: ${payload.referenciaEntrega}`);
}
if (String(payload.tipoEntrega || '').toLowerCase() === 'dine_in' && payload.identificadorMesaSenha) {
  lines.push(`Mesa: ${payload.identificadorMesaSenha}`);
}
if (String(payload.tipoEntrega || '').toLowerCase() === 'pickup') {
  lines.push('Cliente retira no estabelecimento');
}
lines.push('');
lines.push('DADOS DO CLIENTE');
const clientName = firstNonEmpty(
  payload.nomeClienteAvulso,
  payload.usuario?.nomeUsuario,
  payload.usuario?.nome,
  payload.usuario?.username,
  payload.user?.nome,
  payload.user?.username,
  payload.cliente?.nome,
  payload.customer?.name,
  '-'
);
lines.push(`Nome: ${clientName}`);
const clientPhone = firstNonEmpty(
  payload.usuario?.telefone,
  payload.user?.phone,
  payload.telefoneEntrega,
  payload.shippingPhone,
  payload.cliente?.telefone,
  payload.customer?.phone
);
if (clientPhone) lines.push(`Numero: ${clientPhone}`);
const totalOrders = firstNonEmpty(payload.totalPedidos, payload.usuario?.totalPedidos, payload.user?.totalPedidos);
if (totalOrders) lines.push(`Total de pedidos: ${totalOrders}`);
if (payload.usuario?.email) lines.push(payload.usuario.email);
lines.push('');
lines.push('ITENS');
lines.push(`${padRight('Descricao', 24)}${padLeft('Qtd', 4)} ${padLeft('Unit.', 10)}${padLeft('Total', 10)}`);
if (!items.length) {
  lines.push('Sem itens no payload');
} else {
  items.forEach((item) => {
    const qty = Number(item.quantidade || 0);
    const basePrice = Number(item.precoNoPedido || 0);
    const additionalsTotal = (Array.isArray(item.adicionais) ? item.adicionais : []).reduce(
      (acc, a) => acc + Number(a.adicional?.preco || 0) * Number(a.quantidade || 0),
      0
    );
    const unitTotal = basePrice + additionalsTotal;
    const lineTotal = unitTotal * qty;
    const itemName = resolveItemName(item);
    wrapText(itemName, receiptWidth).forEach((l) => lines.push(l));
    const complements = parseItemComplements(item);
    const additionals = parseItemAdditionals(item);
    const flavors = parseItemFlavors(item);
    if (complements) wrapText(`+ ${complements}`, receiptWidth).forEach((l) => lines.push(l));
    if (additionals) wrapText(`+ ${additionals}`, receiptWidth).forEach((l) => lines.push(l));
    if (flavors) wrapText(`Sab.: ${flavors}`, receiptWidth).forEach((l) => lines.push(l));
    const itemObs = extractItemObs(item);
    if (itemObs) wrapText(`Obs.: ${itemObs}`, receiptWidth).forEach((l) => lines.push(l));
    lines.push(formatItemRow(qty, unitTotal, lineTotal));
  });
}

if (payload.observacoes) {
  lines.push('');
  lines.push('------------- OBSERVACOES -------------');
  lines.push(String(payload.observacoes).trim());
}

lines.push('');
lines.push('PAGAMENTO');
lines.push(`Forma ${paymentMethod}`);
if (isPixPayment) lines.push('Pedido ja pago - nao cobrar do cliente.');
if (isCashOnDeliveryPayment) lines.push('Dinheiro na entrega - cobrar do cliente.');
if (isCardPayment) lines.push('Cartao na entrega - cobrar do cliente.');
if (isCashOnDeliveryPayment && payload.precisaTroco && payload.valorTroco) {
  const trocaPara = Number(payload.valorTroco || 0);
  lines.push(`Paga com: ${brl(trocaPara)}`);
  lines.push(`Troco: ${brl(trocaPara - total)}`);
}
lines.push(`Subtotal ${brl(subtotal)}`);
if (String(payload.tipoEntrega || '').toLowerCase() === 'delivery') {
  lines.push(`Entrega ${brl(deliveryFee)}`);
}
lines.push(`TOTAL ${brl(total)}`);
lines.push('');
lines.push('Obrigado pela preferencia');
lines.push(storeName);
lines.push('Powered by MiraDelivery');
lines.push('Acesse: miradelivery.com.br');
lines.push('');

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

    const psScript = `$ErrorActionPreference = 'Stop'
$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Content}'))
$wanted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Printer}'))
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
$content | Out-Printer -Name $printerName
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
