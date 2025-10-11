CREATE DATABASE IF NOT EXISTS flota CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE flota;

CREATE TABLE IF NOT EXISTS cedis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) UNIQUE NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  placa VARCHAR(50) UNIQUE NOT NULL,
  tipo VARCHAR(50) DEFAULT 'CAMION',
  cedis_id INT NULL,
  kilometraje INT DEFAULT 0,
  estado ENUM('ACTIVA','EN_TALLER') DEFAULT 'ACTIVA',
  CONSTRAINT fk_unidades_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mantenimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cedis_id INT NULL,
  tipo VARCHAR(50) NOT NULL,
  motivo VARCHAR(255),
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NULL,
  duracion_dias INT NULL,
  km_al_entrar INT NULL,
  reservado_inventario TINYINT(1) DEFAULT 0,
  creado_por INT NULL,
  CONSTRAINT fk_mants_unidad FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE,
  CONSTRAINT fk_mants_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL,
  INDEX idx_mants_inicio (fecha_inicio),
  INDEX idx_mants_abiertos (fecha_fin)
) ENGINE=InnoDB;
