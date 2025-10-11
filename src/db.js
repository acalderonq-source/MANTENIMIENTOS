// src/db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// Lee variables posibles (DB_* y también las típicas de Railway MYSQL*)
const rawHost = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
const rawPort = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const rawUser = process.env.DB_USER || process.env.MYSQLUSER || 'root';
// Soporta DB_PASS y DB_PASSWORD
const rawPass = process.env.DB_PASS ?? process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '';
const rawDb   = process.env.DB_NAME || process.env.MYSQLDATABASE || 'flota';

// Si el host es *.railway.internal y estamos local, cae a local automáticamente
const isInternalRailway = /\.railway\.internal$/i.test(rawHost);
const devMode = (process.env.NODE_ENV || 'development') !== 'production';

let host = rawHost;
let port = rawPort;
let user = rawUser;
let password = rawPass;
let database = rawDb;

if (isInternalRailway && devMode && process.env.FORCE_RAILWAY_INTERNAL !== '1') {
  console.warn(`[DB] Host interno de Railway (${rawHost}) detectado en local. Usando configuración local fallback.`);
  host = process.env.LOCAL_DB_HOST || '127.0.0.1';
  port = Number(process.env.LOCAL_DB_PORT || 3306);
  user = process.env.LOCAL_DB_USER || 'root';
  password = process.env.LOCAL_DB_PASS || '';
  database = process.env.LOCAL_DB_NAME || 'flota';
}

// SSL opcional (para Railway público, PlanetScale, etc.)
const useSSL = String(process.env.DB_SSL || process.env.MYSQL_SSL || '').toLowerCase() === 'true';
const sslConfig = useSSL ? { rejectUnauthorized: false } : undefined;

// Log seguro (sin password)
console.log('[DB] Conectando a MySQL:', { host, port, user, database, ssl: !!sslConfig });

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(sslConfig ? { ssl: sslConfig } : {})
});
