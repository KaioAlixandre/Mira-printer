/**
 * Modelos padrão das mensagens WhatsApp (Z-API).
 * Use {{nomeDoCampo}} nos textos; o sistema substitui automaticamente.
 */

const DEFAULT_WHATSAPP_TEMPLATES = {
  deliveredConfirmation:
    '*Seu pedido #{{dailyNumber}} foi entregue com sucesso!*\n\nAgradecemos pela preferência!',

  pickupReady: `*Seu pedido #{{dailyNumber}} está pronto para retirada!*

🏪 *Local de retirada:* {{storeName}}{{enderecoLine}}{{referenciaLine}}

💰 *Valor:* R$ {{totalPrice}}{{trocoLine}}
*Itens:*
{{itemsList}}

{{paymentStatusLine}}`,

  deliveryToDeliverer: `*📋 Pedido: #{{dailyNumber}}*

*Cliente:* {{clienteNome}}{{telefoneLine}}

*📍 Endereço:* {{address}}

*Itens:*
{{itemsList}}

💰 *Valor:* R$ {{totalPrice}}{{trocoLine}}{{paymentInfoBlock}}`,

  deliveryToCustomer: `*Seu pedido #{{dailyNumber}} está a caminho!*

*Entregador:* {{delivererName}}
*Contato:* {{delivererPhone}}

*📍 Endereço:* {{address}}

💰 *Valor:* R$ {{totalPrice}}{{trocoCliente}}

{{footerThanks}}`,

  deliveryFooterThanks: '*Obrigado pela preferência!*',

  paymentConfirmed: `*Seu pagamento foi confirmado com sucesso!✅*

*Pedido #{{dailyNumber}}*
💰 *Valor:* R$ {{totalPrice}}{{trocoInfo}}

*Itens:*
{{itemsList}}

*Seu pedido já está em preparo!*

{{tipoEntregaDetails}}`,

  cookNewOrder: `*NOVO PEDIDO PARA PREPARAR*

*Pedido:* #{{dailyNumber}}
*Cliente:* {{clienteNome}}
{{tipoEntregaLine}}
💰 *Valor:* R$ {{totalPrice}}{{trocoInfo}}

*🍽️ ITENS DO PEDIDO:*
{{itemsList}}

{{observacoesBlock}}`,

  orderCancelled: `*Seu pedido #{{dailyNumber}} foi cancelado* ❌

💰 *Valor do pedido:* R$ {{totalPrice}}
*Itens:*
{{itemsList}}

{{refundLine}}

{{closingHelp}}`,

  orderCancelledRefundPix:
    '*Entre em contato conosco para solicitar o reembolso, ou realize outro pedido.*',

  orderCancelledRefundOther:
    '*Entre em contato conosco para mais informações sobre o reembolso.*',

  orderCancelledClosing: '* Estamos à disposição para ajudar!*',

  orderEdited: `*Seu pedido #{{dailyNumber}} foi editado* ✏️

💰 *Valor anterior:* R$ {{oldTotal}}
💰 *Novo valor:* R$ {{newTotal}}
💰 *Diferença:* {{differenceText}}

{{editReasonBlock}}

*Itens do pedido:*
{{itemsList}}

*Se tiver alguma dúvida, entre em contato conosco!*`,

  paymentLabelPix: '*💳 Pagamento:* PIX - Pedido pago',
  paymentLabelCreditCard: '*💳 Pagamento:* Cartão de Crédito/Debito',
  paymentLabelCash: '*💵 Pagamento:* Dinheiro na entrega',
  paymentLabelFallback: '*💳 Pagamento:* {{method}}',

  /** Confirmação imediata ao criar pedido (rota POST /orders — checkout). */
  orderCreatedCard: ` *Pedido Confirmado!* 🎉

 *Pedido Nº:* {{dailyNumber}}

 *Itens:*
{{itemsList}} 

💰 *Total:* R$ {{totalPrice}}
💳 *Forma de pagamento:* Cartão de Crédito/Debito

{{deliveryInfo}}{{notesSection}}

 *Seu pedido já está sendo preparado!*
{{prepFooterLine}}

 *Obrigado pela preferência!*`,

  orderCreatedCash: ` *Pedido Confirmado!* 🎉

 *Pedido Nº:* {{dailyNumber}}

 *Itens:*
{{itemsList}}

💰 *Total:* R$ {{totalPrice}}{{trocoLine}}
💵 *Forma de pagamento:* {{cashPaymentLabel}}

{{deliveryInfo}}{{notesSection}}

 *Seu pedido já está sendo preparado!*
{{cashChangeFooterLine}}

 *Obrigado pela preferência!*`,

  orderCreatedPix: ` *Pedido Confirmado!* 🎉

 *Pedido Nº:* {{dailyNumber}}

 *Itens:*
{{itemsList}}

💰 *Total:* R$ {{totalPrice}}
💸 *Forma de pagamento:* PIX
{{pixKeyIntroLine}}{{deliveryInfo}}{{notesSection}}

📸 *Após o pagamento, por favor envie o comprovante aqui.*

 *Obrigado pela preferência! *`,

  /** Exibida só quando há chave Pix (antes do endereço); no envio com botão copiar. */
  orderCreatedPixKeyIntro: '🔑 *Chave Pix:* (use o botão abaixo para copiar)\n\n',

  /** Anexada no fallback send-text se o botão OTP falhar. */
  orderCreatedPixFallbackAppend: '\n\n🔑 *Chave Pix:* {{storePixKey}}',

  /** Webhook Z-API — resposta automática a saudações (“oi”, menu, etc.). */
  zapiWebhookStoreClosedHeader: 'Olá! No momento estamos fechados.\n\n{{closedDetails}}',

  zapiWebhookClosedByDay:
    'Funcionamos nos seguintes dias: {{diasFormatados}}.\nHorário: {{openingTime}} até {{closingTime}}.',

  zapiWebhookClosedByTime:
    'Nosso horário de funcionamento é de {{openingTime}} até {{closingTime}}.{{diasExtraLine}}',

  zapiWebhookClosedGeneral:
    'Nosso horário é de {{openingTime}} até {{closingTime}}.{{diasExtraLine}}',

  zapiWebhookClosedDiasExtraLine: '\nFuncionamos: {{diasFormatados}}.',

  zapiWebhookGreetingWithMenu: 'Olá! Segue o link do nosso cardápio:\n{{menuLink}}',

  zapiWebhookGreetingNoMenu:
    'Olá! No momento não conseguimos enviar o link do cardápio. Por favor, tente novamente em instantes.',
};

/** Metadados para o painel admin (títulos e ajuda de placeholders). */
const WHATSAPP_TEMPLATES_META = [
  {
    key: 'deliveredConfirmation',
    title: 'Pedido entregue (cliente)',
    description: 'Enviada quando o pedido é marcado como entregue.',
    placeholders: ['dailyNumber'],
  },
  {
    key: 'pickupReady',
    title: 'Pronto para retirada (cliente)',
    description: 'Cliente retira na loja; inclui endereço e forma de pagamento na retirada.',
    placeholders: [
      'dailyNumber',
      'storeName',
      'enderecoLine',
      'referenciaLine',
      'totalPrice',
      'trocoLine',
      'itemsList',
      'paymentStatusLine',
    ],
  },
  {
    key: 'deliveryToDeliverer',
    title: 'Pedido a caminho — mensagem para o entregador',
    description: 'Dados do pedido e endereço para quem vai entregar.',
    placeholders: [
      'dailyNumber',
      'clienteNome',
      'telefoneLine',
      'address',
      'itemsList',
      'totalPrice',
      'trocoLine',
      'paymentInfoBlock',
    ],
  },
  {
    key: 'deliveryToCustomer',
    title: 'Pedido a caminho — mensagem para o cliente',
    description: 'Aviso de que o entregador saiu com o pedido. A linha de agradecimento vem do campo abaixo.',
    placeholders: [
      'dailyNumber',
      'delivererName',
      'delivererPhone',
      'address',
      'totalPrice',
      'trocoCliente',
      'footerThanks',
    ],
  },
  {
    key: 'deliveryFooterThanks',
    title: 'Agradecimento (fim da msg “a caminho” — cliente)',
    description: 'Texto final após o valor do pedido.',
    placeholders: [],
  },
  {
    key: 'paymentConfirmed',
    title: 'Pagamento confirmado — PIX (cliente)',
    description: 'Após confirmação do PIX; o bloco final varia (entrega, retirada ou mesa).',
    placeholders: ['dailyNumber', 'totalPrice', 'trocoInfo', 'itemsList', 'tipoEntregaDetails'],
  },
  {
    key: 'cookNewOrder',
    title: 'Novo pedido — cozinheiros',
    description: 'Enviada aos cozinheiros ativos da loja.',
    placeholders: [
      'dailyNumber',
      'clienteNome',
      'tipoEntregaLine',
      'totalPrice',
      'trocoInfo',
      'itemsList',
      'observacoesBlock',
    ],
  },
  {
    key: 'orderCancelled',
    title: 'Pedido cancelado (corpo principal)',
    description: 'Use {{refundLine}} e {{closingHelp}}; os textos de reembolso são editáveis abaixo.',
    placeholders: ['dailyNumber', 'totalPrice', 'itemsList', 'refundLine', 'closingHelp'],
  },
  {
    key: 'orderCancelledRefundPix',
    title: 'Cancelamento — texto de reembolso (PIX)',
    description: 'Exibido quando o pedido cancelado era PIX.',
    placeholders: [],
  },
  {
    key: 'orderCancelledRefundOther',
    title: 'Cancelamento — texto de reembolso (outros pagamentos)',
    description: 'Cartão, dinheiro, etc.',
    placeholders: [],
  },
  {
    key: 'orderCancelledClosing',
    title: 'Cancelamento — despedida',
    description: 'Linha final de apoio ao cliente.',
    placeholders: [],
  },
  {
    key: 'orderEdited',
    title: 'Pedido editado (cliente)',
    description: 'Valores alterados pelo estabelecimento.',
    placeholders: ['dailyNumber', 'oldTotal', 'newTotal', 'differenceText', 'editReasonBlock', 'itemsList'],
  },
  {
    key: 'orderCreatedCard',
    title: 'Pedido criado — cartão (checkout)',
    description: 'WhatsApp enviado ao cliente ao finalizar com cartão. prepFooterLine muda entre retirada e entrega.',
    placeholders: [
      'dailyNumber',
      'itemsList',
      'totalPrice',
      'deliveryInfo',
      'notesSection',
      'prepFooterLine',
    ],
  },
  {
    key: 'orderCreatedCash',
    title: 'Pedido criado — dinheiro (checkout)',
    description: 'trocoLine fica vazio se não pedir troco; cashPaymentLabel e cashChangeFooterLine vêm do sistema.',
    placeholders: [
      'dailyNumber',
      'itemsList',
      'totalPrice',
      'trocoLine',
      'cashPaymentLabel',
      'deliveryInfo',
      'notesSection',
      'cashChangeFooterLine',
    ],
  },
  {
    key: 'orderCreatedPix',
    title: 'Pedido criado — PIX (checkout)',
    description: 'pixKeyIntroLine só aparece se a loja tiver chave Pix (envio com botão copiar).',
    placeholders: [
      'dailyNumber',
      'itemsList',
      'totalPrice',
      'pixKeyIntroLine',
      'deliveryInfo',
      'notesSection',
    ],
  },
  {
    key: 'orderCreatedPixKeyIntro',
    title: 'Pedido criado — aviso da chave Pix (antes do endereço)',
    description: 'Só usado quando existe chave Pix. Pode deixar vazio para omitir.',
    placeholders: [],
  },
  {
    key: 'orderCreatedPixFallbackAppend',
    title: 'Pedido criado — linha extra no fallback (texto simples)',
    description: 'Se o botão “copiar Pix” falhar, este trecho é acrescentado com a chave.',
    placeholders: ['storePixKey'],
  },
  {
    key: 'zapiWebhookStoreClosedHeader',
    title: 'Webhook Z-API — loja fechada (cabeçalho + detalhe)',
    description: 'Resposta quando o cliente manda “oi” e a loja está fechada. {{closedDetails}} vem dos modelos abaixo conforme o motivo.',
    placeholders: ['closedDetails'],
  },
  {
    key: 'zapiWebhookClosedByDay',
    title: 'Webhook — fechado (hoje não abre)',
    description: 'Quando o dia atual está fora dos dias de funcionamento.',
    placeholders: ['diasFormatados', 'openingTime', 'closingTime'],
  },
  {
    key: 'zapiWebhookClosedByTime',
    title: 'Webhook — fechado (fora do horário)',
    description: '{{diasExtraLine}} lista os dias, se existir; senão fica vazio.',
    placeholders: ['openingTime', 'closingTime', 'diasExtraLine'],
  },
  {
    key: 'zapiWebhookClosedGeneral',
    title: 'Webhook — fechado (loja desligada na config)',
    description: 'Ex.: loja marcada como fechada manualmente.',
    placeholders: ['openingTime', 'closingTime', 'diasExtraLine'],
  },
  {
    key: 'zapiWebhookClosedDiasExtraLine',
    title: 'Webhook — linha extra “Funcionamos: …”',
    description: 'Só é concatenada quando há dias cadastrados.',
    placeholders: ['diasFormatados'],
  },
  {
    key: 'zapiWebhookGreetingWithMenu',
    title: 'Webhook — saudação com link do cardápio',
    description: 'Loja aberta e subdomínio configurado.',
    placeholders: ['menuLink'],
  },
  {
    key: 'zapiWebhookGreetingNoMenu',
    title: 'Webhook — saudação sem link',
    description: 'Quando não há subdomínio para montar a URL.',
    placeholders: [],
  },
  {
    key: 'paymentLabelPix',
    title: 'Rótulo pagamento PIX (na msg do entregador)',
    placeholders: [],
  },
  {
    key: 'paymentLabelCreditCard',
    title: 'Rótulo pagamento cartão (na msg do entregador)',
    placeholders: [],
  },
  {
    key: 'paymentLabelCash',
    title: 'Rótulo pagamento dinheiro (na msg do entregador)',
    placeholders: [],
  },
  {
    key: 'paymentLabelFallback',
    title: 'Rótulo pagamento genérico',
    description: 'Use {{method}} se o método não for um dos anteriores.',
    placeholders: ['method'],
  },
];

module.exports = {
  DEFAULT_WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATES_META,
};
