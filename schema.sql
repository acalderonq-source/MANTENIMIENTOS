CREATE TABLE IF NOT EXISTS cedis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(190) NULL
);

CREATE TABLE IF NOT EXISTS unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  placa VARCHAR(50) UNIQUE NOT NULL,
  tipo VARCHAR(50) NOT NULL,
  cedis_id INT NULL,
  kilometraje INT NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVA',
  FOREIGN KEY (cedis_id) REFERENCES cedis(id)
);

CREATE TABLE IF NOT EXISTS mantenimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cedis_id INT NULL,
  tipo VARCHAR(30) NOT NULL,
  motivo VARCHAR(255) NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NULL,
  duracion_dias INT NULL,
  km_al_entrar INT NULL,
  reservado_inventario TINYINT(1) NOT NULL DEFAULT 0,
  creado_por INT NULL,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id),
  FOREIGN KEY (cedis_id) REFERENCES cedis(id)
);
