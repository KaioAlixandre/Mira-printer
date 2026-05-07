/**
 * Script para criar o banco de dados MySQL (miradelivery_db) se não existir.
 * Usa as credenciais do .env (DATABASE_URL).
 *
 * Uso: node scripts/create-database.js
 * Requer: MySQL rodando em localhost e dotenv carregado (rode da pasta backend).
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

function parseDatabaseUrl(url) {
  const parsed = new URL(url.replace(/^mysql:\/\//, 'mysql://'));
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port, 10) || 3306,
    user: parsed.username || 'root',
    password: parsed.password || '',
    database: (parsed.pathname || '').replace(/^\//, '') || 'miradelivery_db',
  };
}

async function createDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ DATABASE_URL não encontrada no .env');
    process.exit(1);
  }

  const { host, port, user, password, database } = parseDatabaseUrl(url);

  console.log(`🔌 Conectando em ${host}:${port} como ${user}...`);

  let connection;
  try {
    connection = await mysql.createConnection({
      host,
      port,
      user,
      password,
      multipleStatements: true,
    });
  } catch (err) {
    console.error('❌ Erro ao conectar no MySQL:', err.message);
    console.error('   Verifique se o MySQL está rodando e se usuário/senha no .env estão corretos.');
    process.exit(1);
  }

  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✅ Banco de dados "${database}" criado ou já existente.`);
  } catch (err) {
    console.error('❌ Erro ao criar banco:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

createDatabase();
