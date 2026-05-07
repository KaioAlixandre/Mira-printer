const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authModule = require('./auth');
const { authenticateToken, authorize } = authModule;

const multer = require('multer');
const cloudinary = require('../services/cloudinary');
const streamifier = require('streamifier');
const { DEFAULT_WHATSAPP_TEMPLATES, WHATSAPP_TEMPLATES_META } = require('../constants/defaultWhatsappMessages');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test((file.originalname || '').toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Apenas imagens são permitidas'));
  }
});

console.log(' [StoreConfigRoutes] Módulo de rotas de configuração da loja carregado');

const FONTES_HERO_PERMITIDAS = new Set([
  'inter', 'poppins', 'roboto', 'lora', 'merriweather', 'montserrat',
  'playfair-display', 'outfit', 'dm-sans', 'bebas-neue',
  'open-sans', 'nunito', 'raleway', 'oswald', 'ubuntu',
  'm-plus-rounded-1c', 'quicksand', 'fira-sans', 'pt-sans',
  'josefin-sans', 'manrope', 'titillium-web',
]);

// Função auxiliar para obter o dia da semana no fuso horário do Brasil (America/Sao_Paulo)
function getDayOfWeekInBrazil() {
  const brasilNow = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });

  const dateInBrazil = new Date(brasilNow);
  return dateInBrazil.getDay(); // 0 = domingo, 1 = segunda, ..., 6 = sábado
}

router.post('/logo', authenticateToken, authorize('admin'), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo não enviado. Use o campo "logo".' });
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'store-logo', resource_type: 'image' },
        (error, result) => {
          if (result) resolve(result);
          else reject(error);
        }
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const logoUrl = uploadResult.secure_url;

    const config = await prisma.configuracao_loja.upsert({
      where: { lojaId: req.lojaId },
      update: { logoUrl },
      create: {
        lojaId: req.lojaId,
        logoUrl,
        aberto: true,
        horaAbertura: '08:00',
        horaFechamento: '18:00',
        diasAbertos: '2,3,4,5,6,0',
        horaEntregaInicio: '08:00',
        horaEntregaFim: '18:00'
      }
    });

    return res.json({ logoUrl, config });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
  }
});

// Buscar configuração da loja - Acessível para todos
router.get('/', async (req, res) => {
  console.log(` [GET /api/store-config] Iniciando busca da configuração (Loja ID: ${req.lojaId})`);
  
  try {
    // MULTI-TENANT: Agora pedimos para o Prisma trazer os dados da Loja junto com a Configuração!
    // 🌟 MULTI-TENANT: Agora pedimos para o Prisma trazer os dados da Loja junto com a Configuração!
    let config = await prisma.configuracao_loja.findUnique({
      where: { lojaId: req.lojaId },
      include: { loja: true } // Traz o nome, subdomínio e cor primária
    });

    if (!config) {
      console.log('⚠️ Nenhuma configuração encontrada, criando configuração padrão...');
      config = await prisma.configuracao_loja.create({
        data: {
          lojaId: req.lojaId,
          aberto: true,
          horaAbertura: '08:00',
          horaFechamento: '18:00',
          diasAbertos: '2,3,4,5,6,0',
          horaEntregaInicio: '08:00',
          horaEntregaFim: '18:00',
          deliveryAtivo: true,
          cancelamentoPagamentoPendenteAtivo: true
        },
        include: { loja: true }
      });
    }
    
    // Garantir que os campos de entrega estejam presentes na resposta
    if (!config.horaEntregaInicio) config.horaEntregaInicio = '08:00';
    if (!config.horaEntregaFim) config.horaEntregaFim = '18:00';
    
    const configResponse = {
      ...config,
      // 🌟 O Front-end agora vai receber o nome exato que o dono cadastrou!
      nomeLoja: config.loja?.nome || 'Delivery', 
      corPrimaria: config.loja?.corPrimaria || '#FF0000',
      corBannerHero: config.loja?.corBannerHero ?? null,
      corHeroTitulo: config.loja?.corHeroTitulo ?? null,
      corHeroSubtitulo: config.loja?.corHeroSubtitulo ?? null,
      fonteHero: config.loja?.fonteHero ?? null,
      planoMensal: config.loja?.planoMensal || 'simples',
      chavePix: config.chavePix ?? config.telefoneWhatsapp ?? null,
      mensagensWhatsappPadrao: { ...DEFAULT_WHATSAPP_TEMPLATES },
      mensagensWhatsappMeta: WHATSAPP_TEMPLATES_META,
    };
    
    res.json(configResponse);
  } catch (error) {
    console.error('❌ [GET /api/store-config] Erro ao buscar configuração:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar configuração da loja
router.put('/', authenticateToken, authorize('admin'), async (req, res) => {
  console.log(`📡 [PUT /api/store-config] Atualizando configuração (Loja ID: ${req.lojaId})`);
  
  const { 
    aberto, isOpen, horaAbertura: backendOpeningTime, horaFechamento: backendClosingTime, 
    openTime: frontendOpenTime, closeTime: frontendCloseTime, diasAbertos, nomeLoja,
    telefoneWhatsapp, telefoneGerente, chavePix, deliveryEnabled, deliveryAtivo, enderecoLoja,
    ruaLoja, bairroLoja, numeroLoja, pontoReferenciaLoja,
    slogan, instagramUrl,
    taxaEntrega, valorPedidoMinimo, raioEntregaKm, estimativaEntrega,
    promocaoTaxaAtiva, promocaoDias, promocaoValorMinimo, deliveryStart,
    deliveryEnd, horaEntregaInicio: backendDeliveryStart, horaEntregaFim: backendDeliveryEnd,
    logoUrl,
    zapApiToken, zapApiInstance, zapApiClientToken,
    corPrimaria,
    corBannerHero,
    corHeroTitulo,
    corHeroSubtitulo,
    fonteHero,
    horariosPorDia,
    horarioDeliveryPorDia,
    cancelamentoPagamentoPendenteAtivo,
    pagamentoPixAtivo,
    pagamentoDinheiroEntregaAtivo,
    pagamentoDinheiroRetiradaAtivo,
    pagamentoCartaoEntregaAtivo,
    pagamentoCartaoRetiradaAtivo,
    mensagensWhatsapp,
    autoPrintPreparingEnabled,
    autoPrintPreparingCommand,
    autoPrintPrinterType,
    autoPrintPrinterTarget,
    autoPrintPaperWidthMm
  } = req.body;
  
  let existingConfig = null;
  try {
    // 🌟 MULTI-TENANT: Busca apenas da loja logada (não mais id: 1)
    existingConfig = await prisma.configuracao_loja.findUnique({ 
      where: { lojaId: req.lojaId } 
    });
  } catch (e) {
    existingConfig = null;
  }

  const openingTime = frontendOpenTime || backendOpeningTime || existingConfig?.horaAbertura || '08:00';
  const closingTime = frontendCloseTime || backendClosingTime || existingConfig?.horaFechamento || '18:00';
  const diasAbertosFinal = diasAbertos || existingConfig?.diasAbertos || '2,3,4,5,6,0';
  const abertoFinal = (typeof isOpen === 'boolean') ? isOpen : ((typeof aberto === 'boolean') ? aberto : (existingConfig?.aberto ?? true));
  const horaEntregaInicio = deliveryStart || backendDeliveryStart || existingConfig?.horaEntregaInicio || '08:00';
  const horaEntregaFim = deliveryEnd || backendDeliveryEnd || existingConfig?.horaEntregaFim || '18:00';
  const deliveryAtivoFinal = (typeof deliveryEnabled === 'boolean') ? deliveryEnabled : ((typeof deliveryAtivo === 'boolean') ? deliveryAtivo : (existingConfig?.deliveryAtivo ?? true));
  const cancelamentoPagamentoPendenteAtivoFinal = (typeof cancelamentoPagamentoPendenteAtivo === 'boolean')
    ? cancelamentoPagamentoPendenteAtivo
    : (existingConfig?.cancelamentoPagamentoPendenteAtivo ?? true);

  const boolOrExisting = (v, existingVal, fallback = true) =>
    (typeof v === 'boolean') ? v : (existingVal ?? fallback);
  const pagamentoPixAtivoFinal = boolOrExisting(pagamentoPixAtivo, existingConfig?.pagamentoPixAtivo, true);
  const pagamentoDinheiroEntregaAtivoFinal = boolOrExisting(pagamentoDinheiroEntregaAtivo, existingConfig?.pagamentoDinheiroEntregaAtivo, true);
  const pagamentoDinheiroRetiradaAtivoFinal = boolOrExisting(pagamentoDinheiroRetiradaAtivo, existingConfig?.pagamentoDinheiroRetiradaAtivo, true);
  const pagamentoCartaoEntregaAtivoFinal = boolOrExisting(pagamentoCartaoEntregaAtivo, existingConfig?.pagamentoCartaoEntregaAtivo, true);
  const pagamentoCartaoRetiradaAtivoFinal = boolOrExisting(pagamentoCartaoRetiradaAtivo, existingConfig?.pagamentoCartaoRetiradaAtivo, true);
  const promocaoTaxaAtivaFinal = (typeof promocaoTaxaAtiva === 'boolean') ? promocaoTaxaAtiva : (existingConfig?.promocaoTaxaAtiva ?? false);
  const promocaoDiasFinal = (promocaoDias !== undefined) ? (promocaoDias || null) : (existingConfig?.promocaoDias ?? null);
  const promocaoValorMinimoFinal = (promocaoValorMinimo !== undefined) ? (promocaoValorMinimo ? parseFloat(promocaoValorMinimo) : null) : (existingConfig?.promocaoValorMinimo ?? null);

  const taxaEntregaFinal = (taxaEntrega !== undefined)
    ? (taxaEntrega === '' || taxaEntrega === null ? 0 : parseFloat(taxaEntrega))
    : (existingConfig?.taxaEntrega ?? 0);

  const valorPedidoMinimoFinal = (valorPedidoMinimo !== undefined)
    ? (valorPedidoMinimo === '' || valorPedidoMinimo === null ? null : parseFloat(valorPedidoMinimo))
    : (existingConfig?.valorPedidoMinimo ?? null);

  const raioEntregaKmFinal = (raioEntregaKm !== undefined)
    ? (raioEntregaKm === '' || raioEntregaKm === null ? null : parseFloat(raioEntregaKm))
    : (existingConfig?.raioEntregaKm ?? null);

  const estimativaEntregaFinal = (estimativaEntrega !== undefined)
    ? (estimativaEntrega || null)
    : (existingConfig?.estimativaEntrega ?? null);

  const ruaLojaFinal = (ruaLoja !== undefined)
    ? (ruaLoja || null)
    : (existingConfig?.ruaLoja ?? null);

  const bairroLojaFinal = (bairroLoja !== undefined)
    ? (bairroLoja || null)
    : (existingConfig?.bairroLoja ?? null);

  const numeroLojaFinal = (numeroLoja !== undefined)
    ? (numeroLoja || null)
    : (existingConfig?.numeroLoja ?? null);

  const pontoReferenciaLojaFinal = (pontoReferenciaLoja !== undefined)
    ? (pontoReferenciaLoja || null)
    : (existingConfig?.pontoReferenciaLoja ?? null);

  // Compor enderecoLoja a partir dos campos detalhados
  const parts = [ruaLojaFinal, numeroLojaFinal, bairroLojaFinal].filter(Boolean);
  const enderecoLojaFinal = parts.length > 0 ? parts.join(', ') : (existingConfig?.enderecoLoja ?? null);

  const sloganFinal = (slogan !== undefined)
    ? (slogan || null)
    : (existingConfig?.slogan ?? null);

  const instagramUrlFinal = (instagramUrl !== undefined)
    ? (instagramUrl || null)
    : (existingConfig?.instagramUrl ?? null);

  const telefoneWhatsappFinal = (telefoneWhatsapp !== undefined)
    ? (telefoneWhatsapp || null)
    : (existingConfig?.telefoneWhatsapp ?? null);

  const telefoneGerenteFinal = (telefoneGerente !== undefined)
    ? (telefoneGerente || null)
    : (existingConfig?.telefoneGerente ?? null);

  const chavePixFinal = (chavePix !== undefined)
    ? (chavePix || null)
    : (existingConfig?.chavePix ?? null);

  const zapApiTokenFinal = (zapApiToken !== undefined)
    ? (zapApiToken || null)
    : (existingConfig?.zapApiToken ?? null);
  const zapApiInstanceFinal = (zapApiInstance !== undefined)
    ? (zapApiInstance || null)
    : (existingConfig?.zapApiInstance ?? null);
  const zapApiClientTokenFinal = (zapApiClientToken !== undefined)
    ? (zapApiClientToken || null)
    : (existingConfig?.zapApiClientToken ?? null);

  function normalizeMensagensWhatsapp(body) {
    if (body === undefined) return undefined;
    if (body === null) return null;
    if (typeof body !== 'object' || Array.isArray(body)) return undefined;
    const allowed = Object.keys(DEFAULT_WHATSAPP_TEMPLATES);
    const out = {};
    for (const k of allowed) {
      if (typeof body[k] === 'string' && body[k].length <= 12000) {
        out[k] = body[k];
      }
    }
    if (typeof body.zapiOrderFlowEnabled === 'boolean') {
      out.zapiOrderFlowEnabled = body.zapiOrderFlowEnabled;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  const mensagensWhatsappFinal = normalizeMensagensWhatsapp(mensagensWhatsapp);
  const autoPrintPreparingEnabledFinal = (typeof autoPrintPreparingEnabled === 'boolean')
    ? autoPrintPreparingEnabled
    : (existingConfig?.autoPrintPreparingEnabled ?? false);
  const autoPrintPreparingCommandFinal = (autoPrintPreparingCommand !== undefined)
    ? (String(autoPrintPreparingCommand || '').trim() || null)
    : (existingConfig?.autoPrintPreparingCommand ?? null);
  const autoPrintPrinterTypeFinal = (autoPrintPrinterType !== undefined)
    ? (String(autoPrintPrinterType || '').trim() || null)
    : (existingConfig?.autoPrintPrinterType ?? null);
  const autoPrintPrinterTargetFinal = (autoPrintPrinterTarget !== undefined)
    ? (String(autoPrintPrinterTarget || '').trim() || null)
    : (existingConfig?.autoPrintPrinterTarget ?? null);
  const autoPrintPaperWidthMmFinal = (autoPrintPaperWidthMm !== undefined)
    ? (() => {
        const parsed = Number(autoPrintPaperWidthMm);
        return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
      })()
    : (existingConfig?.autoPrintPaperWidthMm ?? 80);
  
  try {
    // 🌟 MULTI-TENANT: Upsert baseado no lojaId!
    const config = await prisma.configuracao_loja.upsert({
      where: { lojaId: req.lojaId }, // Procura a config desta loja
      update: { 
        aberto: abertoFinal,
        deliveryAtivo: deliveryAtivoFinal,
        cancelamentoPagamentoPendenteAtivo: cancelamentoPagamentoPendenteAtivoFinal,
        pagamentoPixAtivo: pagamentoPixAtivoFinal,
        pagamentoDinheiroEntregaAtivo: pagamentoDinheiroEntregaAtivoFinal,
        pagamentoDinheiroRetiradaAtivo: pagamentoDinheiroRetiradaAtivoFinal,
        pagamentoCartaoEntregaAtivo: pagamentoCartaoEntregaAtivoFinal,
        pagamentoCartaoRetiradaAtivo: pagamentoCartaoRetiradaAtivoFinal,
        taxaEntrega: taxaEntregaFinal,
        valorPedidoMinimo: valorPedidoMinimoFinal,
        raioEntregaKm: raioEntregaKmFinal,
        estimativaEntrega: estimativaEntregaFinal,
        enderecoLoja: enderecoLojaFinal,
        ruaLoja: ruaLojaFinal,
        bairroLoja: bairroLojaFinal,
        numeroLoja: numeroLojaFinal,
        pontoReferenciaLoja: pontoReferenciaLojaFinal,
        slogan: sloganFinal,
        instagramUrl: instagramUrlFinal,
        telefoneWhatsapp: telefoneWhatsappFinal,
        telefoneGerente: telefoneGerenteFinal,
        chavePix: chavePixFinal,
        horaAbertura: openingTime, 
        horaFechamento: closingTime, 
        diasAbertos: diasAbertosFinal,
        logoUrl: (logoUrl !== undefined) ? (logoUrl || null) : (existingConfig?.logoUrl ?? null),
        promocaoTaxaAtiva: promocaoTaxaAtivaFinal,
        promocaoDias: promocaoDiasFinal,
        promocaoValorMinimo: promocaoValorMinimoFinal,
        horaEntregaInicio,
        horaEntregaFim,
        horariosPorDia: horariosPorDia !== undefined ? (horariosPorDia || null) : (existingConfig?.horariosPorDia ?? null),
        horarioDeliveryPorDia: horarioDeliveryPorDia !== undefined ? (horarioDeliveryPorDia || null) : (existingConfig?.horarioDeliveryPorDia ?? null),
        zapApiToken: zapApiTokenFinal,
        zapApiInstance: zapApiInstanceFinal,
        zapApiClientToken: zapApiClientTokenFinal,
        autoPrintPreparingEnabled: autoPrintPreparingEnabledFinal,
        autoPrintPreparingCommand: autoPrintPreparingCommandFinal,
        autoPrintPrinterType: autoPrintPrinterTypeFinal,
        autoPrintPrinterTarget: autoPrintPrinterTargetFinal,
        autoPrintPaperWidthMm: autoPrintPaperWidthMmFinal,
        ...(mensagensWhatsappFinal !== undefined ? { mensagensWhatsapp: mensagensWhatsappFinal } : {})
      },
      create: { 
        lojaId: req.lojaId, // 🌟 MULTI-TENANT: Se não existir, cria para esta loja
        aberto: abertoFinal,
        deliveryAtivo: deliveryAtivoFinal,
        cancelamentoPagamentoPendenteAtivo: cancelamentoPagamentoPendenteAtivoFinal,
        pagamentoPixAtivo: pagamentoPixAtivoFinal,
        pagamentoDinheiroEntregaAtivo: pagamentoDinheiroEntregaAtivoFinal,
        pagamentoDinheiroRetiradaAtivo: pagamentoDinheiroRetiradaAtivoFinal,
        pagamentoCartaoEntregaAtivo: pagamentoCartaoEntregaAtivoFinal,
        pagamentoCartaoRetiradaAtivo: pagamentoCartaoRetiradaAtivoFinal,
        taxaEntrega: taxaEntregaFinal,
        valorPedidoMinimo: valorPedidoMinimoFinal,
        raioEntregaKm: raioEntregaKmFinal,
        estimativaEntrega: estimativaEntregaFinal,
        enderecoLoja: enderecoLojaFinal,
        ruaLoja: ruaLojaFinal,
        bairroLoja: bairroLojaFinal,
        numeroLoja: numeroLojaFinal,
        pontoReferenciaLoja: pontoReferenciaLojaFinal,
        slogan: sloganFinal,
        instagramUrl: instagramUrlFinal,
        telefoneWhatsapp: telefoneWhatsappFinal,
        telefoneGerente: telefoneGerenteFinal,
        chavePix: chavePixFinal,
        horaAbertura: openingTime, 
        horaFechamento: closingTime, 
        diasAbertos: diasAbertosFinal,
        logoUrl: (logoUrl !== undefined) ? (logoUrl || null) : (existingConfig?.logoUrl ?? null),
        promocaoTaxaAtiva: promocaoTaxaAtivaFinal,
        promocaoDias: promocaoDiasFinal,
        promocaoValorMinimo: promocaoValorMinimoFinal,
        horaEntregaInicio,
        horaEntregaFim,
        horariosPorDia: horariosPorDia !== undefined ? (horariosPorDia || null) : (existingConfig?.horariosPorDia ?? null),
        horarioDeliveryPorDia: horarioDeliveryPorDia !== undefined ? (horarioDeliveryPorDia || null) : (existingConfig?.horarioDeliveryPorDia ?? null),
        zapApiToken: zapApiTokenFinal,
        zapApiInstance: zapApiInstanceFinal,
        zapApiClientToken: zapApiClientTokenFinal,
        autoPrintPreparingEnabled: autoPrintPreparingEnabledFinal,
        autoPrintPreparingCommand: autoPrintPreparingCommandFinal,
        autoPrintPrinterType: autoPrintPrinterTypeFinal,
        autoPrintPrinterTarget: autoPrintPrinterTargetFinal,
        autoPrintPaperWidthMm: autoPrintPaperWidthMmFinal,
        ...(mensagensWhatsappFinal !== undefined ? { mensagensWhatsapp: mensagensWhatsappFinal } : {})
      }
    });

    // Atualizar dados da loja (nome, cores) se enviados
    const lojaUpdate = {};
    if (typeof nomeLoja === 'string' && nomeLoja.trim()) lojaUpdate.nome = nomeLoja.trim();
    if (corPrimaria !== undefined && /^#[0-9A-Fa-f]{6}$/.test(String(corPrimaria))) lojaUpdate.corPrimaria = String(corPrimaria);
    if (corBannerHero !== undefined) {
      if (corBannerHero === null || corBannerHero === '') lojaUpdate.corBannerHero = null;
      else if (/^#[0-9A-Fa-f]{6}$/.test(String(corBannerHero))) lojaUpdate.corBannerHero = String(corBannerHero);
    }
    if (corHeroTitulo !== undefined) {
      if (corHeroTitulo === null || corHeroTitulo === '') lojaUpdate.corHeroTitulo = null;
      else if (/^#[0-9A-Fa-f]{6}$/.test(String(corHeroTitulo))) lojaUpdate.corHeroTitulo = String(corHeroTitulo);
    }
    if (corHeroSubtitulo !== undefined) {
      if (corHeroSubtitulo === null || corHeroSubtitulo === '') lojaUpdate.corHeroSubtitulo = null;
      else if (/^#[0-9A-Fa-f]{6}$/.test(String(corHeroSubtitulo))) lojaUpdate.corHeroSubtitulo = String(corHeroSubtitulo);
    }
    if (fonteHero !== undefined) {
      if (fonteHero === null || fonteHero === '') {
        lojaUpdate.fonteHero = null;
      } else if (typeof fonteHero === 'string') {
        const k = fonteHero.trim().toLowerCase();
        if (FONTES_HERO_PERMITIDAS.has(k)) lojaUpdate.fonteHero = k;
      }
    }
    if (req.body.planoMensal && ['simples', 'pro', 'plus'].includes(req.body.planoMensal)) lojaUpdate.planoMensal = req.body.planoMensal;
    if (Object.keys(lojaUpdate).length > 0) {
      await prisma.loja.update({
        where: { id: req.lojaId },
        data: lojaUpdate
      });
    }
    
    console.log('✅ Configuração atualizada com sucesso!');
    res.json(config);
  } catch (error) {
    console.error('❌ Erro ao atualizar configuração:', error);
    res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
  }
});

// Verificar se a promoção de frete grátis está ativa hoje
router.get('/promo-frete-check', async (req, res) => {
  try {
    // 🌟 MULTI-TENANT: Busca a config da loja para ver o frete dela
    const config = await prisma.configuracao_loja.findUnique({
      where: { lojaId: req.lojaId }
    });
    
    if (!config || !config.promocaoTaxaAtiva) {
      return res.json({ ativa: false, mensagem: null, valorMinimo: null });
    }
    
    const hoje = getDayOfWeekInBrazil().toString();
    const diasPromo = config.promocaoDias ? config.promocaoDias.split(',') : [];
    
    if (diasPromo.includes(hoje)) {
      const valorMinimo = parseFloat(config.promocaoValorMinimo || 0);
      return res.json({
        ativa: true,
        mensagem: `Promoção de Frete Grátis! Pedidos acima de R$ ${valorMinimo.toFixed(2)} ganham frete grátis hoje!`,
        valorMinimo: valorMinimo
      });
    }
    
    res.json({ ativa: false, mensagem: null, valorMinimo: null });
  } catch (error) {
    console.error('❌ Erro ao verificar promoção:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;