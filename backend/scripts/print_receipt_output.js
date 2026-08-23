/*
  Envia um cupom (linhas + estilos) para a impressora configurada no Mira Printer.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

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

const LEGACY_FONT_SCALE_MULTIPLIER = { small: 0.85, normal: 1, large: 1.2 };

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveWritablePrintsDir() {
  const envDir = String(process.env.MIRA_PRINTS_DIR || '').trim();
  if (envDir) return envDir;

  const userData = String(process.env.MIRA_USER_DATA || '').trim();
  if (userData) return path.join(userData, 'prints');

  return path.resolve(__dirname, '..', 'prints');
}

function loadPrintEnv(printCfg = {}) {
  const localPrinterType = String(process.env.MIRA_PRINTER_TYPE || '').trim();
  const localPrinterTarget = String(process.env.MIRA_PRINTER_TARGET || '').trim();
  const localPaperWidth = Number(process.env.MIRA_PAPER_WIDTH_MM || 0);
  const localContentWidth = Number(process.env.MIRA_CONTENT_WIDTH_MM || 0);
  const fontScale = String(process.env.MIRA_FONT_SCALE || 'normal').toLowerCase();
  const localFontScalePercent = Number(process.env.MIRA_FONT_SCALE_PERCENT || 0);
  const localLineHeight = Number(process.env.MIRA_LINE_HEIGHT || 0);

  const printerType = String(localPrinterType || printCfg.printerType || 'mock_txt').toLowerCase();
  const printerTarget = String(localPrinterTarget || printCfg.printerTarget || '').trim();
  const paperWidthMm = Number(localPaperWidth || printCfg.paperWidthMm || 80);

  const fontScaleMultiplier = clampNumber(
    (localFontScalePercent || printCfg.fontScalePercent || 0) / 100 ||
      LEGACY_FONT_SCALE_MULTIPLIER[fontScale] ||
      1,
    0.6,
    2,
    1
  );

  const receiptLineHeight = clampNumber(
    localLineHeight || printCfg.lineHeight || RECEIPT_LINE_HEIGHT,
    1,
    2.2,
    RECEIPT_LINE_HEIGHT
  );

  function resolveReceiptContentMm(widthMm) {
    const paper = Number(widthMm);
    const paperMm = Number.isFinite(paper) && paper > 0 ? paper : 80;
    const custom = Number(localContentWidth || printCfg.contentWidthMm || 0);
    if (Number.isFinite(custom) && custom > 0) {
      return Math.round(Math.min(paperMm, Math.max(30, custom)));
    }
    if (paperMm >= 76) return RECEIPT_CONTENT_MM;
    return Math.max(40, Math.round(paperMm * (RECEIPT_CONTENT_MM / 80)));
  }

  function resolveReceiptWidth(widthMm) {
    const contentMm = resolveReceiptContentMm(widthMm);
    const baseCols = contentMm * (38 / 80);
    return Math.max(16, Math.round(baseCols / fontScaleMultiplier));
  }

  const receiptContentMm = resolveReceiptContentMm(paperWidthMm);
  const receiptWidth = resolveReceiptWidth(paperWidthMm);

  function scaledFontPt(pt) {
    return (pt * fontScaleMultiplier).toFixed(2);
  }

  return {
    printerType,
    printerTarget,
    paperWidthMm,
    fontScale,
    receiptLineHeight,
    receiptContentMm,
    receiptWidth,
    scaledFontPt,
  };
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

function saveMockTxt(content, filePrefix) {
  const printsDir = resolveWritablePrintsDir();
  if (!fs.existsSync(printsDir)) {
    fs.mkdirSync(printsDir, { recursive: true });
  }
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${filePrefix || 'cupom'}_${safeTimestamp}.txt`;
  const filePath = path.join(printsDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Cupom mock salvo em: ${filePath}`);
  return filePath;
}

async function printWindowsSpooler({ content, lineStyles, env, documentName }) {
  const { printerTarget, paperWidthMm, fontScale, receiptLineHeight, receiptContentMm, receiptWidth, scaledFontPt } =
    env;

  if (!printerTarget) {
    throw new Error('Destino da impressora nao configurado para windows_spooler.');
  }

  const b64Content = Buffer.from(content, 'utf8').toString('base64');
  const b64LineStyles = Buffer.from(JSON.stringify(lineStyles), 'utf8').toString('base64');
  const b64Printer = Buffer.from(printerTarget, 'utf8').toString('base64');
  const b64FontScale = Buffer.from(fontScale, 'utf8').toString('base64');
  const safeDocName = String(documentName || 'Mira Cupom').replace(/'/g, "''");

  const psScript = `$ErrorActionPreference = 'Stop'
$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Content}'))
$lineStylesJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64LineStyles}'))
$wanted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Printer}'))
$fontScale = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64FontScale}'))
$receiptWidth = ${receiptWidth}
$receiptContentMm = ${receiptContentMm}
$paperWidthMm = ${paperWidthMm}
$receiptLineHeight = ${receiptLineHeight.toFixed(2)}
$fontPtBody = ${scaledFontPt(RECEIPT_FONT_PT.body)}
$fontPtMuted = ${scaledFontPt(RECEIPT_FONT_PT.muted)}
$fontPtLarge = ${scaledFontPt(RECEIPT_FONT_PT.large)}
$fontPtTitle = ${scaledFontPt(RECEIPT_FONT_PT.title)}
$fontPtHeading = ${scaledFontPt(RECEIPT_FONT_PT.heading)}
$fontPtItemTitle = ${scaledFontPt(RECEIPT_FONT_PT.itemTitle)}
$fontPtItemPrice = ${scaledFontPt(RECEIPT_FONT_PT.itemPrice)}
$fontPtItemDetail = ${scaledFontPt(RECEIPT_FONT_PT.itemDetail)}
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
$doc.DocumentName = '${safeDocName}'
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

  const tmpPs1 = path.join(os.tmpdir(), `mira-print-${process.pid}-${Date.now()}.ps1`);
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

  console.log('Cupom enviado para impressora Windows (resolvida para nome instalado).');
}

async function printReceipt({
  lines,
  lineStyles,
  documentName = 'Mira Cupom',
  filePrefix = 'cupom',
  printCfg = {},
} = {}) {
  const textLines = Array.isArray(lines) ? lines.map((l) => String(l ?? '')) : [];
  const styles = Array.isArray(lineStyles) ? lineStyles.slice() : [];
  while (styles.length < textLines.length) styles.push('normal');

  const env = loadPrintEnv(printCfg);
  const content = textLines.join('\n');

  if (env.printerType === 'windows_spooler') {
    await printWindowsSpooler({ content, lineStyles: styles, env, documentName });
    return;
  }

  if (env.printerType === 'network_escpos') {
    if (!env.printerTarget) {
      throw new Error('Destino da impressora nao configurado para network_escpos.');
    }
    await sendToNetworkEscPos(env.printerTarget, textLines, styles, env.fontScale);
    console.log(`Cupom enviado para impressora de rede ${env.printerTarget}`);
    return;
  }

  saveMockTxt(content, filePrefix);
}

module.exports = {
  loadPrintEnv,
  printReceipt,
};
