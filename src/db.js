// src/db.js
import mysql from 'mysql2/promise';

const cfg = {
  host: process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'flota',
  sslEnabled: String(process.env.DB_SSL || '').toLowerCase() === 'true',
  dateStrings: String(process.env.DB_DATE_STRINGS || 'true').toLowerCase() === 'true',
  namedPlaceholders: String(process.env.DB_NAMED_PLACEHOLDERS || 'false').toLowerCase() === 'true',
  timezone: process.env.DB_TIMEZONE || 'Z',
};

const pool = mysql.createPool({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: cfg.dateStrings,
  namedPlaceholders: cfg.namedPlaceholders,
  timezone: cfg.timezone,
  ...(cfg.sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
});

console.log(
  `[DB] MySQL pool listo -> ${cfg.host}:${cfg.port} / ${cfg.database} (ssl=${cfg.sslEnabled})`
);

export { pool, cfg };
