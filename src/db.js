// src/db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// ====== Señales de plataforma ======
const IS_RAILWAY =
  process.env.RAILWAY === '1' ||
  !!process.env.RAILWAY_STATIC_URL ||
  !!process.env.RAILWAY_ENVIRONMENT ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME;

const IS_RENDER = !!process.env.RENDER || !!process.env.RENDER_SERVICE_ID;

// ====== Lectura de variables ======
let rawHost = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
let rawPort = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
let rawUser = process.env.DB_USER || process.env.MYSQLUSER || 'root';
// Soporta DB_PASS y DB_PASSWORD
let rawPass = process.env.DB_PASS ?? process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '';
let rawDb   = process.env.DB_NAME || process.env.MYSQLDATABASE || 'flota';

// --- Protección: si por error pusieron una URL completa en DB_HOST, parsearla ---
try {
  // mysql://root:pass@host:24607/railway
  if (/^mysql:\/\//i.test(rawHost)) {
    const u = new URL(rawHost);
    if (u.hostname) rawHost = u.hostname;
    if (u.port) rawPort = Number(u.port);
    if (u.username) rawUser = decodeURIComponent(u.username);
    if (u.password) rawPass = decodeURIComponent(u.password);
    if (u.pathname && u.pathname.length > 1) rawDb = u.pathname.slice(1);
  }
} catch (_) { /* noop */ }

const isInternalRailway = /\.railway\.internal$/i.test(rawHost);
const isRailwayProxy    = /\.proxy\.rlwy\.net$/i.test(rawHost);

// ====== Fallbacks y overrides ======
let host = rawHost;
let port = rawPort;
let user = rawUser;
let password = rawPass;
let database = rawDb;

// Permite forzar el uso del host interno (por ejemplo, si realmente estás en Railway)
const FORCE_RAILWAY_INTERNAL = process.env.FORCE_RAILWAY_INTERNAL === '1';

// Si el host interno de Railway se usa fuera de Railway → caer a local
if (isInternalRailway && !IS_RAILWAY && !FORCE_RAILWAY_INTERNAL) {
  console.warn(`[DB] Host interno de Railway (${rawHost}) detectado fuera de Railway (p.ej. Render/local). Usando fallback local/override.`);
  host = process.env.LOCAL_DB_HOST || '127.0.0.1';
  port = Number(process.env.LOCAL_DB_PORT || 3306);
  user = process.env.LOCAL_DB_USER || 'root';
  password = process.env.LOCAL_DB_PASS || '';
  database = process.env.LOCAL_DB_NAME || 'flota';
}

// **Normalización para External Connection de Railway**
// Si el host es *.proxy.rlwy.net y no definiste DB_NAME/DB_PORT, usar:
//   DB_NAME=railway, DB_PORT=24607
if (isRailwayProxy) {
  if (!process.env.DB_NAME && !process.env.MYSQLDATABASE) {
    database = 'railway';
  }
  if (!process.env.DB_PORT && !process.env.MYSQLPORT) {
    port = 24607;
  }
}

// SSL opcional (para proveedores que lo exigen)
const useSSL = String(process.env.DB_SSL || process.env.MYSQL_SSL || '').toLowerCase() === 'true';
const sslConfig = useSSL ? { rejectUnauthorized: false } : undefined;

// Opcionales útiles
const dateStrings = String(process.env.DB_DATE_STRINGS || 'true').toLowerCase() === 'true'; // default true
const namedPlaceholders = String(process.env.DB_NAMED_PLACEHOLDERS || 'false').toLowerCase() === 'true';
const timezone = process.env.DB_TIMEZONE || 'Z'; // UTC
const poolMax = Number(process.env.DB_POOL_SIZE || 10);

// Log seguro (sin password)
console.log('[DB] Conectando a MySQL:', {
  host, port, user, database,
  ssl: !!sslConfig,
  dateStrings, namedPlaceholders, timezone,
  onRailway: IS_RAILWAY, onRender: IS_RENDER,
  isRailwayInternal: isInternalRailway, isRailwayProxy
});

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: poolMax,
  queueLimit: 0,
  ...(sslConfig ? { ssl: sslConfig } : {}),
  dateStrings,
  namedPlaceholders,
  timezone,
  // timeouts para evitar colgarse → 502
  connectTimeout: 10000,
  acquireTimeout: 10000
});

// (Opcional) helper para ping
export async function pingDb() {
  const [r] = await pool.query('SELECT 1 AS ok');
  return r?.[0]?.ok === 1;
}

// (Opcional) cierre limpio
process.on('SIGTERM', async () => {
  try {
    console.log('[DB] SIGTERM recibido. Cerrando pool...');
    await pool.end();
    console.log('[DB] Pool cerrado.');
    process.exit(0);
  } catch (e) {
    console.error('[DB] Error al cerrar pool:', e);
    process.exit(1);
  }
});
