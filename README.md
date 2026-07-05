# Mira Printer Agent

Agente **Electron** (Windows) que autentica como admin/master na API, mantém o **JWT** com **safeStorage**, conecta ao **Socket.IO** com `auth: { token }` e dispara o script de impressão (`AUTO_PRINT_ORDER_JSON`).

## Backend (Mira-Delivery)

No servidor, os pedidos em tempo real são emitidos **apenas** para a room `loja_<lojaId>` (não há mais `io.emit` global para esses eventos). O handshake Socket.IO exige JWT válido e papel permitido (padrão: `admin`, `master`).

Variável opcional no servidor:

- `SOCKET_PRINTER_ROLES` — lista separada por vírgulas (ex.: `admin,master`).
- `AUTO_PRINT_PREPARING_ALLOW_NON_WINDOWS` — padrão `0`; em Linux o backend ignora `triggerAutoPrint` para evitar tentativa de spooler Windows. Defina `1` apenas se você realmente for imprimir no servidor (ex.: `network_escpos`).

Rota de login para este agente (igual ao painel SaaS):

- `POST /api/auth/login-store-admin` — body: `{ telefone, password }`. Resolve admin/master pelo telefone em qualquer loja e devolve token + `subdominio` + objeto `loja` (`id`, `nome`).

## Requisitos

- Windows x64
- Node.js LTS para desenvolvimento

## Primeira execução / login

1. Informe a URL da API (`API_HTTP_BASE`), ex.: `https://api.sua-loja.com`.
2. **Telefone** e senha de **admin/master** (rota `login-store-admin` — não exige subdomínio no formulário).

O token é gravado em `userData/session.json` com segredo via **Electron safeStorage** (quando disponível).

## Configuração de impressão na UI

Na janela principal, em **Impressão local**, você pode salvar:

- tipo (`windows_spooler`, `network_escpos`, `mock_txt`);
- destino (nome da impressora Windows ou `IP:PORTA`);
- largura do papel (`58` / `80`);
- escala de fonte (`small` / `normal` / `large`), aplicada em ESC/POS de rede.

Essas opções ficam em `userData/print-settings.json` e sobrescrevem o `__autoPrintConfig` vindo do backend.

## Socket.IO e TLS

Use a **mesma origem** que o navegador usa para a API: se a API é HTTPS, o cliente Socket.IO usará **WSS** automaticamente ao conectar em `https://...`.

Se o token JWT expirar ou o servidor recusar o handshake (`TOKEN_EXPIRED`, papel inválido), faça **login novamente** na janela de configuração. A API também pode usar refresh via cookie em navegadores; neste agente o fluxo principal é relogar ao receber erro de auth no socket.

## Variáveis opcionais (`config.json` / `.env`)

| Chave | Descrição |
|--------|-----------|
| `AUTO_PRINT_SCRIPT_PATH` | Caminho absoluto do `.js` de impressão (padrão: `backend/scripts/auto_print_preparing_orders.js` dentro do app) |
| `PRINT_TRIGGERS` | `new_order`, `being_prepared` ou `both` |
| `DEDUP_POLICY` | `order_and_event` ou `one_per_order` |
| `USE_ELECTRON_AS_NODE` | `1` (padrão) usa o executável Electron como Node |
| `START_MINIMIZED` | `1` inicia só na bandeja |
| `OPEN_AT_LOGIN` | `1` abre ao iniciar sessão no Windows |
| `PRINT_WS_ENABLED` | `1` (padrão) inicia servidor WebSocket local para o botão **Imprimir** do painel |
| `PRINT_WS_PORT` | Porta local (padrão `8787`) |
| `PRINT_WS_HOST` | Host de escuta (padrão `127.0.0.1`) |

`API_HTTP_BASE` pode ser sobrescrito por arquivo de configuração; a sessão gravada no login prevalece para URL + loja.

## Impressão manual (WebSocket do painel)

Com o agente aberto, o painel admin pode enviar pedidos pelo botão **Imprimir** via WebSocket:

- URL padrão no frontend: `VITE_PRINT_WS_URL=ws://localhost:8787`
- Mensagem: `{ "type": "print_order", "version": 1, "order": { ... }, "user": { ... }, "flavors": [ ... ] }`
- Resposta: `{ "type": "print_ack", "orderId": <id>, "ok": true }` ou `ok: false` com `error`

O agente converte o objeto `order` do painel e executa o mesmo script de cupom usado na impressão automática.

## Desenvolvimento

```bash
npm install
npm start
```

## Build

```bash
npm run dist
```

Saída em `release/` (NSIS + portable). O projeto usa `signAndEditExecutable: false` para evitar falhas de extração de ferramentas de assinatura em ambientes Windows sem symlink; ajuste para CI com assinatura real.

### Assinatura de código (opcional)

Use certificado Authenticode (`signtool` da Windows SDK) no `.exe` / instalador.

## Rede

Garanta **HTTPS/WSS** em produção, firewall liberando saída do PC da impressora para host/porta da API, e que o **subdomínio** enviado no login corresponda à loja no banco.

## Dedup

Arquivo `userData/print-dedup.json` — apague com o app fechado para forçar reimpressão.

## Licença

MIT
