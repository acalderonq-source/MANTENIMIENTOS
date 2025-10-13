// src/db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Lectura básica de variables (con alias compatibles).
 * Prioriza DB_*; acepta MYSQL* por compatibilidad.
 */
let host = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
let port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
let user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
// Soporta DB_PASS y DB_PASSWORD, y alias MYSQLPASSWORD
let password = process.env.DB_PASS ?? process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '';
let database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'flota';

// Contexto del runtime
const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
const onRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const onRailway = !!process.env.RAILWAY_ENVIRONMENT_NAME;

// Heurísticas de host
const isRailwayInternal = /\.railway\.internal$/i.test(host);   // solo funciona dentro de Railway
const isRailwayProxy    = /\.proxy\.rlwy\.net$/i.test(host);    // External Connection (fuera de Railway)

/**
 * Normalización para Railway External:
 *  - Si el host es *.proxy.rlwy.net y NO te pasaron DB_NAME explícito, usa 'railway'
 *  - Si no te pasaron puerto, sugiere 24607 (típico en Railway External)
 */
if (isRailwayProxy) {
  if (!process.env.DB_NAME && !process.env.MYSQLDATABASE) {
    database = 'railway';
  }
  if (!process.env.DB_PORT && !process.env.MYSQLPORT) {
    port = 24607;
  }
}

/**
 * Fallback local si accidentalmente apuntas a un host interno de Railway desde desarrollo.
 * Se puede forzar ignorar este fallback con FORCE_RAILWAY_INTERNAL=1
 */
const forceInternal = String(process.env.FORCE_RAILWAY_INTERNAL || '0') === '1';
const isDev = nodeEnv !== 'production';

if (isRailwayInternal && isDev && !forceInternal) {
  console.warn(`[DB] Host interno de Railway (${host}) detectado en entorno local. Usando configuración local fallback.`);
  host = process.env.LOCAL_DB_HOST || '127.0.0.1';
  port = Number(process.env.LOCAL_DB_PORT || 3306);
  user = process.env.LOCAL_DB_USER || 'root';
  password = process.env.LOCAL_DB_PASS || '';
  database = process.env.LOCAL_DB_NAME || 'flota';
}

/**
 * SSL opcional. Pon DB_SSL=true si tu proveedor exige TLS (PlanetScale, MySQL gestionado, etc.)
 * En Railway External normalmente NO es obligatorio; si lo activas, usa rejectUnauthorized:false
 */
const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const sslConfig = useSSL ? { rejectUnauthorized: false } : undefined;

/**
 * Log sanitario (sin contraseña).
 */
console.log('[DB] Conectando a MySQL:', {
  host,
  port,
  user,
  database,
  ssl: !!sslConfig,
  dateStrings: true,
  namedPlaceholders: false,
  timezone: 'Z',
  onRailway,
  onRender,
  isRailwayInternal,
  isRailwayProxy
});

/**
 * Pool de conexiones.
 * Notas:
 *  - dateStrings:true para evitar objetos Date en TZ diferentes (entrega cadenas).
 *  - timezone:'Z' para tratar fechas en UTC desde el driver (útil en servidores).
 */
export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_MAX || 10),
  queueLimit: 0,
  dateStrings: true,
  timezone: 'Z',
  ...(sslConfig ? { ssl: sslConfig } : {})
});

/**
 * Utilidad opcional: ping de salud (por si quieres usarla en tu server).
 */
export async function dbPing() {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
