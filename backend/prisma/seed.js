const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando plantio de dados (Seed)...');

  // 1. Criar a sua primeira Loja (Tenant 1)
  const loja = await prisma.loja.create({
    data: {
      nome: 'Mira Delivery Matriz',
      subdominio: 'mira', // Acesso será mira.miradelivery.com.br
      corPrimaria: '#FF0000', // Vermelho (pode mudar depois)
    },
  });
  console.log(`🏪 Loja criada: ${loja.nome} (ID: ${loja.id})`);

  // 2. Criar as configurações obrigatórias dessa loja
  await prisma.configuracao_loja.create({
    data: {
      lojaId: loja.id,
      aberto: true,
      horaAbertura: '18:00',
      horaFechamento: '23:59',
      diasAbertos: 'Seg-Dom',
    }
  });
  console.log('⚙️ Configurações da loja criadas!');

  // 3. Criar o seu usuário dono da loja (Admin)
  const admin = await prisma.usuario.create({
    data: {
      lojaId: loja.id,
      nomeUsuario: 'admin',
      email: 'admin@miradelivery.com',
      senha: '123456', // No futuro, seu sistema de login vai usar senhas criptografadas
      funcao: 'master', 
      telefone: '11999999999'
    }
  });
  console.log(`👤 Usuário master criado: ${admin.nomeUsuario}`);

  // 4. Criar uma Categoria
  const categoria = await prisma.categoria_produto.create({
    data: {
      lojaId: loja.id,
      nome: 'Lanches Especiais',
    }
  });
  console.log(`🍔 Categoria criada: ${categoria.nome}`);

  // 5. Criar um Produto vinculado à Loja e à Categoria
  const produto = await prisma.produto.create({
    data: {
      lojaId: loja.id,
      nome: 'Super Hamburguer Mira',
      preco: 35.90,
      descricao: 'Pão brioche, blend 200g, queijo cheddar e bacon.',
      categoriaId: categoria.id,
      ativo: true,
      destaque: true,
    }
  });
  console.log(`🍟 Produto criado: ${produto.nome}`);

  console.log('✅ Seed finalizado com sucesso! Seu banco está pronto.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });