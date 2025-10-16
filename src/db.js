// src/db.js
import mysql from 'mysql2/promise';

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'flota',
  sslEnabled: String(process.env.DB_SSL || '').toLowerCase() === 'true',
  connLimit: Number(process.env.DB_CONN_LIMIT || 10),
  dateStrings: String(process.env.DB_DATE_STRINGS || '').toLowerCase() === 'true',
};

const pool = mysql.createPool({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  waitForConnections: true,
  connectionLimit: cfg.connLimit,
  queueLimit: 0,
  ssl: cfg.sslEnabled ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: cfg.dateStrings,
});

console.log(`[DB] MySQL pool listo -> ${cfg.host}:${cfg.port} / ${cfg.database} (ssl=${cfg.sslEnabled})`);

export { pool, cfg };
