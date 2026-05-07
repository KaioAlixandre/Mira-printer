require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const { setRealtimeServer } = require('./services/realtimeEvents');
const { createSocketAuthMiddleware } = require('./services/socketIoAuth');

// 🌟 IMPORTANDO O MIDDLEWARE DA LOJA
const tenantMiddleware = require('./middleware/tenantMiddleware');

// Instancie o PrismaClient
const prisma = new PrismaClient();
const app = express();
const httpServer = http.createServer(app);

// Porta dinâmica para a DigitalOcean
const PORT = process.env.PORT || 3001; 

// Importar as rotas
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/produtos');
const orderRoutes = require('./routes/pedidos');
const delivererRoutes = require('./routes/delivererRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const cartRoutes = require('./routes/cartRoutes');
const insightsRoutes = require('./routes/insiths');
const storeConfigRoutes = require('./routes/configuracao'); 
const complementsRoutes = require('./routes/complementsRoutes'); 
const flavorsRoutes = require('./routes/flavorsRoutes');
const additionalsRoutes = require('./routes/additionalsRoutes');
const passwordResetRoutes = require('./routes/passwordResetRoutes');
const cozinheirosRoutes = require('./routes/cozinheiros');
const garconsRoutes = require('./routes/garcons');
const mesasRoutes = require('./routes/mesas');
const zapiWebhookRoutes = require('./routes/zapiWebhook');
const deliveryNeighborhoodRoutes = require('./routes/deliveryNeighborhoods');
const masterRoutes = require('./routes/master');
const billingRoutes = require('./routes/billing');
const { handleStripeWebhook } = require('./routes/stripeWebhook');
const { startAutomaticDeliveryShiftNotifier } = require('./services/messageService');

// 1. Middlewares Globais
app.use(cors({
    origin: true,
    credentials: true,
}));
app.use(cookieParser());

const io = new Server(httpServer, {
    cors: {
        origin: true,
        credentials: true
    }
});

setRealtimeServer(io);

io.use(createSocketAuthMiddleware());

io.on('connection', (socket) => {
    const lid = socket.data?.lojaId;
    console.log(`🔌 Cliente realtime conectado: ${socket.id} → loja_${lid}`);
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Cliente realtime desconectado: ${socket.id} (${reason})`);
    });
});

// Webhook da Stripe precisa do payload bruto para validar assinatura.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());

// 2. Webhooks e rotas master (não usam tenantMiddleware)
app.use('/webhooks/zapi', zapiWebhookRoutes);
app.use('/api/master', masterRoutes);

// Função para testar a conexão com o banco de dados
const connectDB = async () => {
    try {
        await prisma.$connect();
        console.log('✅ Conectado com sucesso ao banco de dados!');
    } catch (err) {
        console.error('❌ Erro ao conectar ao banco de dados:', err);
        process.exit(1);
    }
};

// Conectar ao banco de dados e iniciar o servidor
connectDB().then(() => {
    
    // =======================================================
    // A MÁGICA ACONTECE AQUI! (MOVIMENTADO PARA CIMA)
    // Aplicamos o tenantMiddleware a TODAS as rotas /api.
    // Assim, o req.lojaId estará disponível para o /register e /login.
    // =======================================================
    app.use('/api', tenantMiddleware);

    // 3. Rotas de Autenticação (Agora já possuem acesso ao req.lojaId)
    app.use('/api/auth', authRoutes.router);
    app.use('/api/auth', passwordResetRoutes);

    // 4. Outras Rotas Privadas/Públicas da Loja
    app.use('/api/products', productRoutes);
    app.use('/api/orders', orderRoutes);
    app.use('/api/deliverers', delivererRoutes);
    app.use('/api/dashboard', dashboardRoutes);
    app.use('/api/cart', cartRoutes);
    app.use('/api/insights', insightsRoutes);
    app.use('/api/store-config', storeConfigRoutes);
    app.use('/api/billing', billingRoutes);
    app.use('/api/complements', complementsRoutes);
    app.use('/api/complement-categories', require('./routes/complementCategoriesRoutes'));
    app.use('/api/flavors', flavorsRoutes);
    app.use('/api/flavor-categories', require('./routes/flavorCategoriesRoutes'));
    app.use('/api/additionals', additionalsRoutes);
    app.use('/api/additional-categories', require('./routes/additionalCategoriesRoutes'));
    app.use('/api/cozinheiros', cozinheirosRoutes);
    app.use('/api/garcons', garconsRoutes);
    app.use('/api/mesas', mesasRoutes);
    app.use('/api/delivery-neighborhoods', deliveryNeighborhoodRoutes.router);
    
    // Rota de debug temporária
    const debugRoutes = require('./routes/debug');
    app.use('/api', debugRoutes);
    
    // Servir arquivos estáticos
    app.use('/uploads', express.static('uploads'));

    // Rota de teste raiz
    app.get('/', (req, res) => {
        res.send('API da Açaíteria funcionando!');
    });

    // Iniciar o servidor
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor da API rodando na porta ${PORT}`);
        startAutomaticDeliveryShiftNotifier();
    });
});
