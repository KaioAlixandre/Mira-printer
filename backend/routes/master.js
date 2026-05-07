const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const JWT_SECRET = process.env.JWT_SECRET;

// Função para remover máscara do telefone
const removePhoneMask = (phone) => {
    if (!phone) return phone;
    return phone.toString().replace(/\D/g, '');
};

// Função para formatar subdomínio
function formatSubdomain(subdomain) {
    return subdomain
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
        .replace(/[^a-z0-9-]/g, '-') // substitui espaços por hífen
        .replace(/-+/g, '-') // remove hífens duplicados
        .replace(/^-|-$/g, ''); // remove hífen no começo ou fim
}

// Função auxiliar para obter data/hora atual no fuso de São Paulo
function getNowInSaoPaulo() {
  const brasilNow = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  return new Date(brasilNow);
}

// Função auxiliar para converter hora (HH:MM) em minutos
function timeToMinutes(time) {
  if (!time) return 0;
  const [hours, minutes] = time.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

// Função auxiliar para verificar se está dentro da janela de horário
function isWithinWindow(nowMinutes, openMinutes, closeMinutes) {
  // Se o horário de fechamento é no dia seguinte (ex: 08:00 às 02:00)
  if (closeMinutes < openMinutes) {
    return nowMinutes >= openMinutes || nowMinutes <= closeMinutes;
  }
  // Horário normal (ex: 08:00 às 22:00)
  return nowMinutes >= openMinutes && nowMinutes <= closeMinutes;
}

// Função para obter o valor do plano mensal
function getPlanValue(planoMensal) {
    const planValues = {
        'simples': 97,
        'pro': 197,
        'plus': 270
    };
    return planValues[planoMensal] || 0;
}

// Função para verificar se a loja está aberta
async function checkStoreStatus(lojaId) {
  const config = await prisma.configuracao_loja.findUnique({ where: { lojaId } });
  
  if (!config) {
    return { isOpen: false, reason: 'Sem configuração' };
  }

  const aberto = (config.aberto ?? true) === true;
  if (!aberto) {
    return { isOpen: false, reason: 'Fechada manualmente' };
  }

  const now = getNowInSaoPaulo();
  const day = now.getDay();

  // Verificar se tem horários por dia configurados
  let horarioDoDia = null;
  if (config.horariosPorDia && typeof config.horariosPorDia === 'object') {
    horarioDoDia = config.horariosPorDia[String(day)];
  }

  if (horarioDoDia) {
    if (!horarioDoDia.aberto) {
      return { isOpen: false, reason: 'Fechada neste dia' };
    }
    
    const openMinutes = timeToMinutes(horarioDoDia.abertura);
    const closeMinutes = timeToMinutes(horarioDoDia.fechamento);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    
    const within = isWithinWindow(nowMinutes, openMinutes, closeMinutes);
    if (!within) {
      return { isOpen: false, reason: 'Fora do horário' };
    }
    
    return { isOpen: true };
  }

  // Fallback: usar configuração geral de dias
  const dias = (config.diasAbertos || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  
  if (dias.length > 0 && !dias.includes(String(day))) {
    return { isOpen: false, reason: 'Fechada neste dia' };
  }

  const openMinutes = timeToMinutes(config.horaAbertura);
  const closeMinutes = timeToMinutes(config.horaFechamento);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const within = isWithinWindow(nowMinutes, openMinutes, closeMinutes);
  if (!within) {
    return { isOpen: false, reason: 'Fora do horário' };
  }

  return { isOpen: true };
}

// Middleware de autenticação para rotas master (não depende de tenantMiddleware)
const authenticateMasterToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Token não fornecido.' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await prisma.usuario.findUnique({
            where: { id: decoded.id },
            select: { id: true, funcao: true, nomeUsuario: true }
        });
        
        if (!user) {
            return res.status(401).json({ message: 'Usuário não encontrado.' });
        }
        
        if (user.funcao !== 'master') {
            return res.status(403).json({ message: 'Acesso negado: apenas usuários master podem acessar esta rota.' });
        }
        
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Token inválido.' });
    }
};

// Listar todas as lojas (apenas master)
router.get('/stores', authenticateMasterToken, async (req, res) => {
    console.log(`🔍 [GET /api/master/stores] Master ${req.user.id} solicitando lista de todas as lojas`);
    
    try {
        const lojas = await prisma.loja.findMany({
            include: {
                _count: {
                    select: {
                        usuarios: true,
                        pedidos: true
                    }
                },
                pedidos: {
                    select: {
                        precoTotal: true
                    }
                },
                configuracao_loja: {
                    select: {
                        telefoneWhatsapp: true
                    }
                },
                usuarios: {
                    where: {
                        funcao: 'admin'
                    },
                    select: {
                        telefone: true
                    },
                    take: 1
                }
            },
            orderBy: {
                criadoEm: 'desc'
            }
        });

        const lojasComEstatisticas = await Promise.all(lojas.map(async (loja) => {
            const receitaPedidos = loja.pedidos.reduce((sum, pedido) => {
                return sum + Number(pedido.precoTotal || 0);
            }, 0);
            
            // Valor do plano mensal da loja
            const valorPlano = getPlanValue(loja.planoMensal);

            const status = await checkStoreStatus(loja.id);
            
            // Priorizar telefone WhatsApp da configuração, senão usar telefone do admin
            const telefone = loja.configuracao_loja?.telefoneWhatsapp || 
                            (loja.usuarios && loja.usuarios.length > 0 ? loja.usuarios[0].telefone : null);

            return {
                id: loja.id,
                nome: loja.nome,
                subdominio: loja.subdominio,
                corPrimaria: loja.corPrimaria,
                planoMensal: loja.planoMensal,
                criadoEm: loja.criadoEm.toISOString(),
                totalUsuarios: loja._count.usuarios,
                totalPedidos: loja._count.pedidos,
                receitaPedidos: receitaPedidos,
                valorPlano: valorPlano,
                isOpen: status.isOpen,
                statusReason: status.reason,
                telefone: telefone
            };
        }));

        // Calcular receita total (soma dos valores dos planos)
        const receitaTotalPlanos = lojasComEstatisticas.reduce((sum, loja) => {
            return sum + loja.valorPlano;
        }, 0);

        console.log(`✅ [GET /api/master/stores] ${lojasComEstatisticas.length} lojas encontradas`);
        res.json({
            lojas: lojasComEstatisticas,
            receitaTotal: receitaTotalPlanos
        });
    } catch (err) {
        console.error('❌ [GET /api/master/stores] Erro interno ao buscar lojas:', err);
        res.status(500).json({ message: 'Erro ao buscar lojas.' });
    }
});

// Criar nova loja (apenas master)
router.post('/stores', authenticateMasterToken, async (req, res) => {
    console.log(`➕ [POST /api/master/stores] Master ${req.user.id} criando nova loja`);
    
    const { nomeLoja, subdominio, corPrimaria, planoMensal, criarAdmin, username, telefone, password, email } = req.body;
    
    if (!nomeLoja || !subdominio) {
        return res.status(400).json({ message: 'Nome da loja e subdomínio são obrigatórios.' });
    }
    
    const planoSelecionado = ['simples', 'pro', 'plus'].includes(planoMensal) ? planoMensal : 'simples';
    const subdominioFormatado = formatSubdomain(subdominio);
    
    if (!subdominioFormatado) {
        return res.status(400).json({ message: 'Subdomínio inválido.' });
    }
    
    try {
        // Verificar se o subdomínio já existe
        const lojaExistente = await prisma.loja.findUnique({
            where: { subdominio: subdominioFormatado }
        });
        
        if (lojaExistente) {
            return res.status(409).json({ message: 'Este subdomínio já está em uso.' });
        }
        
        // Se criarAdmin for true, validar dados do admin
        if (criarAdmin) {
            if (!username || !telefone || !password) {
                return res.status(400).json({ message: 'Para criar admin, informe username, telefone e senha.' });
            }
            
            const telefoneLimpo = removePhoneMask(telefone);
            if (telefoneLimpo.length < 10 || telefoneLimpo.length > 11) {
                return res.status(400).json({ message: 'Telefone inválido.' });
            }
            
            if (password.length < 6) {
                return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
            }
        }
        
        // Criar loja e opcionalmente admin em transação
        const resultado = await prisma.$transaction(async (tx) => {
            // Criar a loja
            const novaLoja = await tx.loja.create({
                data: {
                    nome: nomeLoja,
                    subdominio: subdominioFormatado,
                    corPrimaria: corPrimaria || '#EA1D2C',
                    planoMensal: planoSelecionado,
                }
            });
            
            // Criar configuração padrão
            await tx.configuracao_loja.create({
                data: {
                    lojaId: novaLoja.id,
                    aberto: true,
                    horaAbertura: '08:00',
                    horaFechamento: '23:59',
                    diasAbertos: '0,1,2,3,4,5,6',
                    horaEntregaInicio: '08:00',
                    horaEntregaFim: '23:59',
                    deliveryAtivo: true
                }
            });
            
            // Criar admin se solicitado
            let novoUsuario = null;
            if (criarAdmin) {
                const telefoneLimpo = removePhoneMask(telefone);
                const hashedPassword = await bcrypt.hash(password, 10);
                
                novoUsuario = await tx.usuario.create({
                    data: {
                        lojaId: novaLoja.id,
                        nomeUsuario: username.trim(),
                        telefone: telefoneLimpo,
                        email: email || null,
                        senha: hashedPassword,
                        funcao: 'admin'
                    }
                });
            }
            
            return { novaLoja, novoUsuario };
        });
        
        console.log(`✅ [POST /api/master/stores] Loja criada: ${resultado.novaLoja.nome} (ID: ${resultado.novaLoja.id})`);
        
        res.status(201).json({
            message: 'Loja criada com sucesso!',
            loja: resultado.novaLoja,
            usuario: resultado.novoUsuario
        });
    } catch (err) {
        console.error('❌ [POST /api/master/stores] Erro ao criar loja:', err);
        if (err.code === 'P2002') {
            return res.status(409).json({ message: 'Subdomínio já está em uso.' });
        }
        res.status(500).json({ message: 'Erro ao criar loja.' });
    }
});

// Editar loja (apenas master)
router.put('/stores/:id', authenticateMasterToken, async (req, res) => {
    const { id } = req.params;
    const { nomeLoja, subdominio, corPrimaria, planoMensal } = req.body;
    
    console.log(`✏️ [PUT /api/master/stores/${id}] Master ${req.user.id} editando loja`);
    
    try {
        const loja = await prisma.loja.findUnique({ where: { id: parseInt(id) } });
        
        if (!loja) {
            return res.status(404).json({ message: 'Loja não encontrada.' });
        }
        
        const updateData = {};
        
        if (nomeLoja !== undefined) {
            updateData.nome = nomeLoja.trim();
        }
        
        if (subdominio !== undefined) {
            const subdominioFormatado = formatSubdomain(subdominio);
            if (!subdominioFormatado) {
                return res.status(400).json({ message: 'Subdomínio inválido.' });
            }
            
            // Verificar se o novo subdomínio já está em uso por outra loja
            const lojaComSubdominio = await prisma.loja.findUnique({
                where: { subdominio: subdominioFormatado }
            });
            
            if (lojaComSubdominio && lojaComSubdominio.id !== parseInt(id)) {
                return res.status(409).json({ message: 'Este subdomínio já está em uso por outra loja.' });
            }
            
            updateData.subdominio = subdominioFormatado;
        }
        
        if (corPrimaria !== undefined) {
            updateData.corPrimaria = corPrimaria;
        }
        
        if (planoMensal !== undefined) {
            const planoValido = ['simples', 'pro', 'plus'].includes(planoMensal);
            if (!planoValido) {
                return res.status(400).json({ message: 'Plano inválido. Use: simples, pro ou plus.' });
            }
            updateData.planoMensal = planoMensal;
        }
        
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ message: 'Nenhum campo para atualizar.' });
        }
        
        const lojaAtualizada = await prisma.loja.update({
            where: { id: parseInt(id) },
            data: updateData
        });
        
        console.log(`✅ [PUT /api/master/stores/${id}] Loja atualizada: ${lojaAtualizada.nome}`);
        
        res.json({
            message: 'Loja atualizada com sucesso!',
            loja: lojaAtualizada
        });
    } catch (err) {
        console.error(`❌ [PUT /api/master/stores/${id}] Erro ao editar loja:`, err);
        if (err.code === 'P2002') {
            return res.status(409).json({ message: 'Subdomínio já está em uso.' });
        }
        res.status(500).json({ message: 'Erro ao editar loja.' });
    }
});

// Excluir loja (apenas master)
router.delete('/stores/:id', authenticateMasterToken, async (req, res) => {
    const { id } = req.params;
    
    console.log(`🗑️ [DELETE /api/master/stores/${id}] Master ${req.user.id} excluindo loja`);
    
    try {
        const loja = await prisma.loja.findUnique({
            where: { id: parseInt(id) },
            include: {
                _count: {
                    select: {
                        pedidos: true,
                        usuarios: true
                    }
                }
            }
        });
        
        if (!loja) {
            return res.status(404).json({ message: 'Loja não encontrada.' });
        }
        
        // Avisar sobre dados que serão deletados
        const temPedidos = loja._count.pedidos > 0;
        const temUsuarios = loja._count.usuarios > 0;
        
        // Deletar a loja (cascade vai deletar tudo relacionado)
        await prisma.loja.delete({
            where: { id: parseInt(id) }
        });
        
        console.log(`✅ [DELETE /api/master/stores/${id}] Loja excluída: ${loja.nome}`);
        
        res.json({
            message: 'Loja excluída com sucesso!',
            lojaExcluida: {
                id: loja.id,
                nome: loja.nome,
                pedidosDeletados: loja._count.pedidos,
                usuariosDeletados: loja._count.usuarios
            }
        });
    } catch (err) {
        console.error(`❌ [DELETE /api/master/stores/${id}] Erro ao excluir loja:`, err);
        res.status(500).json({ message: 'Erro ao excluir loja.' });
    }
});

module.exports = router;

