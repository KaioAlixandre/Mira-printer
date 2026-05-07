const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken, authorize } = require('./auth');

// Middleware para restringir o acesso apenas a administradores
router.use(authenticateToken, authorize('admin'));

// Rota para obter um relatório diário de vendas
router.get('/daily-sales/:date', async (req, res) => {
    const { date } = req.params;
    console.log(`[GET /api/insights/daily-sales/${date}] Requisição para relatório diário recebida.`);
    try {
        const report = await prisma.relatorio_vendas_diario.findUnique({
            where: { lojaId_data: { lojaId: req.lojaId, data: new Date(date) } },
        });
        if (!report) {
            console.warn(`[GET /api/insights/daily-sales/${date}] Nenhum relatório encontrado para a data: ${date}.`);
            return res.status(404).json({ message: 'Nenhum relatório encontrado para esta data.' });
        }
        console.log(`[GET /api/insights/daily-sales/${date}] Relatório diário encontrado com sucesso.`);
        res.status(200).json(report);
    } catch (err) {
        console.error(`[GET /api/insights/daily-sales/${date}] Erro ao buscar o relatório diário:`, err.message);
        res.status(500).json({ message: 'Erro ao buscar o relatório diário.', error: err.message });
    }
});

// Rota para obter um relatório de vendas de produto
router.get('/product-sales/:date', async (req, res) => {
    const { date } = req.params;
    console.log(`[GET /api/insights/product-sales/${date}] Requisição para relatório de vendas de produto recebida.`);
    try {
        const report = await prisma.relatorio_vendas_produto.findMany({
            where: { lojaId: req.lojaId, data: new Date(date) },
            include: { produto: true },
        });
        if (report.length === 0) {
            console.warn(`[GET /api/insights/product-sales/${date}] Nenhum relatório de produto encontrado para a data: ${date}.`);
            return res.status(404).json({ message: 'Nenhum relatório de produto encontrado para esta data.' });
        }
        console.log(`[GET /api/insights/product-sales/${date}] Relatório de vendas de produto encontrado com sucesso (${report.length} itens).`);
        res.status(200).json(report);
    } catch (err) {
        console.error(`[GET /api/insights/product-sales/${date}] Erro ao buscar o relatório de vendas de produto:`, err.message);
        res.status(500).json({ message: 'Erro ao buscar o relatório de vendas de produto.', error: err.message });
    }
});

// Rota para obter um relatório de vendas por categoria
router.get('/category-sales/:date', async (req, res) => {
    const { date } = req.params;
    console.log(`[GET /api/insights/category-sales/${date}] Requisição para relatório de vendas por categoria recebida.`);
    try {
        const report = await prisma.relatorio_vendas_categoria.findMany({
            where: { lojaId: req.lojaId, data: new Date(date) },
            include: { categoria: true },
        });
        if (report.length === 0) {
            console.warn(`[GET /api/insights/category-sales/${date}] Nenhum relatório de categoria encontrado para a data: ${date}.`);
            return res.status(404).json({ message: 'Nenhum relatório de categoria encontrado para esta data.' });
        }
        console.log(`[GET /api/insights/category-sales/${date}] Relatório de vendas por categoria encontrado com sucesso (${report.length} itens).`);
        res.status(200).json(report);
    } catch (err) {
        console.error(`[GET /api/insights/category-sales/${date}] Erro ao buscar o relatório de vendas por categoria:`, err.message);
        res.status(500).json({ message: 'Erro ao buscar o relatório de vendas por categoria.', error: err.message });
    }
});

module.exports = router;
