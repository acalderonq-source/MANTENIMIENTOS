CREATE DATABASE IF NOT EXISTS `MANTENIMIENTOS` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE `MANTENIMIENTOS`;

-- crea tablas mínimas
CREATE TABLE IF NOT EXISTS cedis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  placa VARCHAR(32) NOT NULL UNIQUE,
  tipo VARCHAR(50) DEFAULT 'OTRO',
  cedis_id INT NULL,
  kilometraje INT NULL,
  estado ENUM('ACTIVA','EN_TALLER','INACTIVA') DEFAULT 'ACTIVA',
  CONSTRAINT fk_unidades_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mantenimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cedis_id INT NULL,
  tipo ENUM('PREVENTIVO','CORRECTIVO') NOT NULL DEFAULT 'PREVENTIVO',
  motivo VARCHAR(255) NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NULL,
  duracion_dias INT NULL,
  km_al_entrar INT NULL,
  reservado_inventario TINYINT(1) DEFAULT 0,
  creado_por INT NULL,
  CONSTRAINT fk_mant_unidad FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE,
  CONSTRAINT fk_mant_cedis FOREIGN KEY (cedis_id) REFERENCES cedis(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(50) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol_id INT NOT NULL,
  activo TINYINT(1) DEFAULT 1,
  CONSTRAINT fk_user_rol FOREIGN KEY (rol_id) REFERENCES roles(id)
) ENGINE=InnoDB;

INSERT IGNORE INTO roles(id, nombre) VALUES (1,'ADMIN'),(2,'OPERADOR');

-- Usuario admin/admin (hash bcrypt)
INSERT IGNORE INTO usuarios (id, username, password_hash, rol_id, activo) VALUES
(1,'admin','$2a$10$3V4Eo0oP2mKQy4i5oUxcQeRr1qB8hP4G7dN3r4aQb3qfKk1eP0v5W',1,1);
ALTER TABLE mantenimientos
  DROP COLUMN duracion_dias,
  ADD COLUMN duracion_dias INT GENERATED ALWAYS AS (DATEDIFF(COALESCE(fecha_fin, CURDATE()), fecha_inicio)) STORED;
