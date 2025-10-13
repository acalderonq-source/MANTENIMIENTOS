// scripts/init-schema-now.mjs
import 'dotenv/config';
import mysql from 'mysql2/promise';

const host = process.env.DB_HOST || process.env.MYSQLHOST || 'localhost';
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASSWORD || process.env.DB_PASS || process.env.MYSQLPASSWORD || '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway';
const useSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const ssl = useSSL ? { rejectUnauthorized: false } : undefined;

// --- Esquema mínimo (idéntico al que te pasé) ---
const SQL = `
CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE \`${database}\`;

CREATE TABLE IF NOT EXISTS cedis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  placa VARCHAR(20) NOT NULL UNIQUE,
  tipo VARCHAR(30) NOT NULL DEFAULT 'CAMION',
  cedis_id INT NULL,
  kilometraje INT NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVA',
  CONSTRAINT fk_unidades_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mantenimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cedis_id INT NULL,
  tipo VARCHAR(30) NOT NULL DEFAULT 'PREVENTIVO',
  motivo VARCHAR(255) NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NULL,
  km_al_entrar INT NULL,
  duracion_dias INT GENERATED ALWAYS AS (
    CASE
      WHEN fecha_fin IS NULL THEN NULL
      ELSE DATEDIFF(fecha_fin, fecha_inicio)
    END
  ) STORED,
  reservado_inventario TINYINT(1) NOT NULL DEFAULT 0,
  creado_por INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mants_unidad FOREIGN KEY (unidad_id) REFERENCES unidades(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_mants_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  INDEX idx_mant_fi (fecha_inicio),
  INDEX idx_mant_ff (fecha_fin),
  INDEX idx_mant_unidad (unidad_id),
  INDEX idx_mant_cedis (cedis_id)
) ENGINE=InnoDB;

-- Semillas básicas (opcionales)
INSERT IGNORE INTO cedis (nombre) VALUES
('Cartago'), ('Alajuela'), ('Guapiles'), ('La Cruz'),
('San Carlos'), ('Nicoya'), ('Perez Zeledon'), ('TRANSPORTADORA');
`;

async function main() {
  console.log('[INIT] Conectando a MySQL...', { host, port, user, database, ssl: !!ssl });
  const conn = await mysql.createConnection({ host, port, user, password, ssl, multipleStatements: true });
  await conn.query(SQL);
  // Verificación rápida:
  const [tables] = await conn.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
    [database]
  );
  await conn.end();
  console.log('[OK] Esquema aplicado. Tablas:', tables.map(t => t.table_name).join(', '));
}

main().catch(err => {
  console.error('[FATAL] No se pudo aplicar el esquema:', err);
  process.exit(1);
});
