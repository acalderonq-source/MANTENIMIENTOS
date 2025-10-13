// scripts/apply_schema.mjs
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const host = process.env.DB_HOST || process.env.MYSQLHOST;
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASSWORD || process.env.DB_PASS || process.env.MYSQLPASSWORD || '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway';

const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const ssl = useSSL ? { rejectUnauthorized: false } : undefined;

const schemaPath = path.join(process.cwd(), 'schema.sql');

async function main() {
  if (!fs.existsSync(schemaPath)) {
    console.error(`[ERROR] No existe schema.sql en: ${schemaPath}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(schemaPath, 'utf8').trim();
  if (!sql) {
    console.error('[ERROR] schema.sql está vacío');
    process.exit(1);
  }

  console.log('[INFO] Conectando a MySQL...', { host, port, user, database, ssl: !!ssl });
  const conn = await mysql.createConnection({
    host, port, user, password, ssl, multipleStatements: true
  });

  // Asegura DB (por si acaso)
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
  await conn.query(`USE \`${database}\`;`);
  console.log('[INFO] Aplicando schema.sql...');
  await conn.query(sql);
  await conn.end();
  console.log('[OK] Schema aplicado en la base:', database);
}

main().catch(err => {
  console.error('[FATAL] Error aplicando schema:', err);
  process.exit(1);
});
