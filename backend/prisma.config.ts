import path from 'node:path';
import { defineConfig } from '@prisma/config';
import { config } from 'dotenv';

// Com prisma.config.ts presente, o Prisma não carrega .env automaticamente.
// Carregar aqui para que env("DATABASE_URL") no schema funcione.
config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
});