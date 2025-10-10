import dotenv from 'dotenv';
dotenv.config();

const DRIVER = (process.env.DB_DRIVER || 'MYSQL').toUpperCase();
if (DRIVER === 'MEMORY'){
  console.log('🧪 DB_DRIVER=MEMORY → Seed no necesario (datos demo en memoria).');
  process.exit(0);
}

import { pool } from './db.js';
import bcrypt from 'bcryptjs';

const sql = `
CREATE TABLE IF NOT EXISTS roles(
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(50) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios(
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(200) NOT NULL,
  rol_id INT NOT NULL,
  activo TINYINT DEFAULT 1,
  FOREIGN KEY (rol_id) REFERENCES roles(id)
);
CREATE TABLE IF NOT EXISTS cedis(
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(120) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS unidades(
  id INT PRIMARY KEY AUTO_INCREMENT,
  placa VARCHAR(20) UNIQUE NOT NULL,
  tipo ENUM('CABEzal','CISTERNA','HINO','OTRO') DEFAULT 'OTRO',
  cedis_id INT,
  kilometraje INT DEFAULT 0,
  estado ENUM('ACTIVA','EN_TALLER','INACTIVA') DEFAULT 'ACTIVA',
  FOREIGN KEY (cedis_id) REFERENCES cedis(id)
);
CREATE TABLE IF NOT EXISTS mantenimientos(
  id INT PRIMARY KEY AUTO_INCREMENT,
  unidad_id INT NOT NULL,
  cedis_id INT,
  tipo ENUM('PREVENTIVO','CORRECTIVO') NOT NULL,
  motivo TEXT,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NULL,
  duracion_dias INT NULL,
  km_al_entrar INT,
  reservado_inventario TINYINT DEFAULT 1,
  creado_por INT NULL,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id),
  FOREIGN KEY (cedis_id) REFERENCES cedis(id)
);
`;

async function main(){
  const conn = await pool.getConnection();
  try{
    for (const stmt of sql.split(';')){
      const s = stmt.trim();
      if(s) await conn.query(s);
    }
    await conn.query("INSERT IGNORE INTO roles (id, nombre) VALUES (1,'ADMIN'), (2,'TALLER'), (3,'PROVEEDURIA'), (4,'JEFE')");
    await conn.query("INSERT IGNORE INTO cedis (id, nombre) VALUES (1,'CEDIS - Cartago'),(2,'CEDIS - Alajuela'),(3,'CEDIS - Guápiles'),(4,'CEDIS - Pérez Zeledón')");
    await conn.query("INSERT IGNORE INTO unidades (id, placa, tipo, cedis_id, kilometraje) VALUES (1,'C167062','HINO',4,183400),(2,'C178662','HINO',4,162000),(3,'C176256','HINO',4,155200),(4,'C156672','HINO',3,140000)");
    const pass = await bcrypt.hash('admin123', 10);
    await conn.query("INSERT IGNORE INTO usuarios (id, username, password_hash, rol_id) VALUES (1,'admin', ?, 1)", [pass]);
    console.log('✅ Tablas creadas y datos iniciales insertados.');
  } finally {
    conn.release();
    process.exit(0);
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
