#!/bin/sh
set -e

echo "🚀 Iniciando entrypoint do backend..."

# Gerar Prisma Client (caso não tenha sido gerado)
echo "📦 Gerando Prisma Client..."
npx prisma generate

# Executar migrações do banco (ou db push se não houver migrações)
echo "🗄️ Aplicando schema do banco de dados..."
if npx prisma migrate deploy 2>/dev/null; then
  echo "✅ Migrações aplicadas."
else
  echo "⚠️ Nenhuma migração encontrada; aplicando schema com db push..."
  npx prisma db push || true
fi

# Executar o comando passado como argumento
echo "✅ Iniciando aplicação..."
exec "$@"

