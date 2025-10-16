// scripts/create-db.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const sqlPath = path.join(__dirname, 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const { DB_HOST, DB_PORT = 3306, DB_USER, DB_PASSWORD } = process.env;
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
    // ssl: { rejectUnauthorized: false } // si tu proveedor lo exige
  });

  console.log('[DB:init] Ejecutando scripts/init.sql ...');
  await conn.query(sql);
  await conn.end();
  console.log('[DB:init] OK');
}

main().catch((e) => {
  console.error('[DB:init] ERROR', e);
  process.exit(1);
});
