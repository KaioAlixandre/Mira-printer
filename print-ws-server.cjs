const { WebSocketServer } = require('ws');

/**
 * Servidor WebSocket local para impressão manual disparada pelo painel (Frontend).
 * Protocolo: { type: "print_order", version: 1, order, user?, flavors?, customerOrderCount? }
 * Resposta:  { type: "print_ack", orderId, ok, error? }
 */
function createPrintWsServer({ port, host, onPrintOrder }) {
  const listenHost = host || '127.0.0.1';
  const listenPort = Number(port) || 8787;

  const wss = new WebSocketServer({ host: listenHost, port: listenPort });

  wss.on('connection', (ws, req) => {
    const from = req?.socket?.remoteAddress || '?';
    console.log(`[print-ws] cliente conectado (${from})`);

    ws.on('message', (data) => {
      void handleMessage(ws, data, onPrintOrder);
    });

    ws.on('close', () => {
      console.log('[print-ws] cliente desconectado');
    });
  });

  wss.on('listening', () => {
    console.log(`[print-ws] escutando em ws://${listenHost}:${listenPort}`);
  });

  wss.on('error', (err) => {
    console.error('[print-ws] erro no servidor:', err.message);
  });

  return {
    wss,
    port: listenPort,
    host: listenHost,
    close() {
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

async function handleMessage(ws, data, onPrintOrder) {
  let msg;
  try {
    msg = JSON.parse(String(data || ''));
  } catch {
    sendAck(ws, null, false, 'JSON inválido');
    return;
  }

  if (!msg || msg.type !== 'print_order' || msg.version !== 1) {
    return;
  }

  const orderId = msg.order?.id ?? msg.order?.orderId ?? null;

  try {
    if (typeof onPrintOrder !== 'function') {
      throw new Error('Servidor de impressão não configurado');
    }
    await onPrintOrder(msg);
    sendAck(ws, orderId, true);
  } catch (err) {
    const message = err?.message || String(err);
    console.error('[print-ws] falha ao imprimir pedido', orderId, message);
    sendAck(ws, orderId, false, message);
  }
}

function sendAck(ws, orderId, ok, error) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        type: 'print_ack',
        orderId,
        ok: !!ok,
        ...(error ? { error: String(error) } : {}),
      })
    );
  } catch (_) {}
}

module.exports = { createPrintWsServer };
