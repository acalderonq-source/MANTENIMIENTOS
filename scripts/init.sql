-- scripts/init.sql
CREATE DATABASE IF NOT EXISTS flota CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE flota;

CREATE TABLE IF NOT EXISTS cedis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  placa VARCHAR(20) UNIQUE NOT NULL,
  tipo VARCHAR(40) DEFAULT 'CAMION',
  cedis_id INT NULL,
  kilometraje INT DEFAULT 0,
  estado VARCHAR(20) DEFAULT 'ACTIVA',
  FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mantenimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cedis_id INT NULL,
  tipo VARCHAR(30) NOT NULL,     -- PREVENTIVO / CORRECTIVO
  motivo TEXT,
  fecha_inicio DATE,
  fecha_fin DATE,
  duracion_dias INT,
  km_al_entrar INT,
  reservado_inventario TINYINT DEFAULT 0,
  creado_por INT NULL,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE,
  FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(40) UNIQUE NOT NULL
);

INSERT IGNORE INTO roles (id, nombre) VALUES (1, 'ADMIN'), (2, 'OPERADOR');

CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  rol_id INT NOT NULL DEFAULT 1,
  activo TINYINT DEFAULT 1,
  FOREIGN KEY (rol_id) REFERENCES roles(id)
);

-- admin / admin
INSERT IGNORE INTO usuarios (username, password_hash, rol_id, activo)
VALUES (
  'admin',
  '$2a$10$F0b1W1VcHqk6f56m1nD2nO4mQfS5b4QZyKzI8m9j0oWwqgQ6o7Q3S',
  1,
  1
);
