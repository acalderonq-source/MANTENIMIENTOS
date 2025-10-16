// src/db.js
import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

function bool(v, def=false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

// Toma DB_* y si faltan usa MYSQL*; default a 'railway'
const host = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway';
const sslEnabled = bool(process.env.DB_SSL, false);

// (Muy importante) Ignora DATABASE_URL para evitar que pise la config
// Si quisieras soportarlo, tendrías que parsearlo y solo usarlo si no hay DB_*

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: bool(process.env.DB_DATE_STRINGS, true),
  namedPlaceholders: bool(process.env.DB_NAMED_PLACEHOLDERS, false),
  timezone: process.env.DB_TIMEZONE || 'Z',
  ssl: sslEnabled ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
}).promise();

export const cfg = { host, port, database, sslEnabled };
