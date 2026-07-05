import type { Flavor, Order } from '../types';

export interface PrintJobPayload {
  type: 'print_order';
  version: 1;
  requestedAt: string;
  order: Order;
  user?: {
    nomeUsuario?: string;
    telefone?: string;
    email?: string;
  };
  flavors?: Flavor[];
  customerOrderCount?: number;
}

const DEFAULT_WS_URL = 'ws://localhost:8787';

const getWsUrl = (): string => {
  const url = (import.meta as any).env?.VITE_PRINT_WS_URL as string | undefined;
  return (url && url.trim()) || DEFAULT_WS_URL;
};

let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
const pending: string[] = [];

const openSocket = (): Promise<WebSocket> => {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connecting) return connecting;

  connecting = new Promise<WebSocket>((resolve, reject) => {
    try {
      const ws = new WebSocket(getWsUrl());

      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };

      const onOpen = () => {
        socket = ws;
        cleanup();
        connecting = null;
        // Flush fila pendente
        while (pending.length > 0 && ws.readyState === WebSocket.OPEN) {
          const msg = pending.shift();
          if (msg) ws.send(msg);
        }
        resolve(ws);
      };

      const onError = () => {
        cleanup();
        connecting = null;
        reject(new Error('Falha ao conectar no WebSocket de impressão'));
      };

      const onClose = () => {
        cleanup();
        connecting = null;
        if (socket === ws) socket = null;
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    } catch (err) {
      connecting = null;
      reject(err instanceof Error ? err : new Error('Falha ao criar WebSocket'));
    }
  });

  return connecting;
};

export async function sendPrintOrderJob(payload: Omit<PrintJobPayload, 'type' | 'version' | 'requestedAt'>) {
  const msg: PrintJobPayload = {
    type: 'print_order',
    version: 1,
    requestedAt: new Date().toISOString(),
    ...payload
  };

  const raw = JSON.stringify(msg);

  // Se já estiver aberto, manda direto.
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(raw);
    return;
  }

  // Se ainda não conectou, enfileira e tenta conectar.
  pending.push(raw);

  // Tenta conectar e dá um timeout curto para feedback no UI.
  const timeoutMs = 1500;
  await Promise.race([
    openSocket().then(() => undefined),
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timeout conectando no WebSocket de impressão')), timeoutMs)
    )
  ]);
}

