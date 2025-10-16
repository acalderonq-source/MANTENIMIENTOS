// src/db.js
import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

const bool = (v, def=false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
};

const host = process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway';

const sslEnabled = bool(process.env.DB_SSL, false);
const sslRejectUnauthorized = bool(process.env.DB_SSL_REJECT_UNAUTHORIZED, true);

const sslConfig = sslEnabled
  ? { minVersion: 'TLSv1.2', rejectUnauthorized: sslRejectUnauthorized }
  : undefined;

export const pool = mysql.createPool({
  host, port, user, password, database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: bool(process.env.DB_DATE_STRINGS, true),
  namedPlaceholders: bool(process.env.DB_NAMED_PLACEHOLDERS, false),
  timezone: process.env.DB_TIMEZONE || 'Z',
  ssl: sslConfig,
}).promise();

export const cfg = { host, port, database, sslEnabled, sslRejectUnauthorized };
