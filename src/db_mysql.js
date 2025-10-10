// src/db.js
import mysql from 'mysql2/promise';

const {
  DB_HOST,
  DB_PORT = 3306,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_CONN_LIMIT = 10,
} = process.env;

if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.warn('[DB] Faltan variables de entorno para MySQL. Revisa .env');
}

export const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(DB_CONN_LIMIT),
  queueLimit: 0,
  // Descomenta si tu proveedor requiere SSL sin verificación (a veces en nubes)
  // ssl: { rejectUnauthorized: false }
});

console.log(`[DB] MySQL pool listo -> ${DB_HOST}:${DB_PORT} / ${DB_NAME}`);
