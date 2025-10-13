// src/db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// -------- Sanitizadores para evitar "mysql -h ..." o URL completas en DB_HOST -----
function extractHost(s) {
  if (!s) return '';
  const t = String(s).trim();
  const mH = t.match(/-h\s+([^\s]+)/i);
  if (mH) return mH[1];
  try {
    if (/^mysql:\/\//i.test(t)) return new URL(t).hostname;
  } catch {}
  return t;
}
function extractPort(rawHost, rawPort) {
  if (rawPort) return Number(rawPort);
  const t = String(rawHost || '').trim();
  const mP = t.match(/-P\s+(\d+)/i);
  if (mP) return Number(mP[1]);
  try {
    if (/^mysql:\/\//i.test(t)) {
      const u = new URL(t);
      return u.port ? Number(u.port) : 3306;
    }
  } catch {}
  return 3306;
}

// -------- Lectura env --------
const rawHost = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
const rawPort = process.env.DB_PORT || process.env.MYSQLPORT || '';
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASS ?? process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway';

let host = extractHost(rawHost);
let port = extractPort(rawHost, rawPort);

// Railway internal host fuera de Railway → fallback local (opcional)
const isInternalRailway = /\.railway\.internal$/i.test(host);
const IS_RAILWAY = !!process.env.RAILWAY || !!process.env.RAILWAY_ENVIRONMENT;
if (isInternalRailway && !IS_RAILWAY && process.env.FORCE_RAILWAY_INTERNAL !== '1') {
  console.warn(`[DB] Host interno Railway (${host}) detectado fuera de Railway. Usando fallback local.`);
  host = process.env.LOCAL_DB_HOST || '127.0.0.1';
  port = Number(process.env.LOCAL_DB_PORT || 3306);
}

const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const sslConfig = useSSL ? { rejectUnauthorized: false } : undefined;

console.log('[DB] Conectando a MySQL:', {
  host, port, user, database,
  ssl: !!sslConfig,
  dateStrings: true,
  namedPlaceholders: false,
  timezone: 'Z'
});

export const pool = mysql.createPool({
  host, port, user, password, database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  ...(sslConfig ? { ssl: sslConfig } : {}),
  dateStrings: true,
  timezone: 'Z'
});

export async function pingDb() {
  const [r] = await pool.query('SELECT 1 AS ok');
  return r?.[0]?.ok === 1;
}

process.on('SIGTERM', async () => {
  try {
    console.log('[DB] SIGTERM: cerrando pool...');
    await pool.end();
    console.log('[DB] Pool cerrado.');
    process.exit(0);
  } catch (e) {
    console.error('[DB] Error cerrando pool:', e);
    process.exit(1);
  }
});
