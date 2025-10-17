// src/server.js
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import methodOverride from 'method-override';
import expressLayouts from 'express-ejs-layouts';
import dayjs from 'dayjs';
import { pool, cfg as dbCfg } from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* =========================
   Vistas & Middlewares
========================= */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
// NO uses include('partials/layout') en las vistas; usa este layout:
app.set('layout', 'partials/layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '../public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false,
    saveUninitialized: false,
  })
);

// helpers a vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* =========================
   Reglas de programación
========================= */

// Capacidad diaria por sede (nombre). Ajusta a tus nombres reales de la tabla `cedis.nombre`
const CAPACIDAD_POR_SEDE = {
  Cartago: 5,
  Transportadora: 5,
  default: 1,
};

function capacidadDeSede(nombre = '') {
  if (!nombre) return CAPACIDAD_POR_SEDE.default;
  if (/cartago/i.test(nombre)) return CAPACIDAD_POR_SEDE.Cartago;
  if (/transportadora/i.test(nombre)) return CAPACIDAD_POR_SEDE.Transportadora;
  return CAPACIDAD_POR_SEDE.default;
}

function esDomingo(iso) {
  return dayjs(iso).day() === 0;
}

function siguienteHabil(d) {
  let x = dayjs(d);
  while (x.day() === 0) x = x.add(1, 'day');
  return x;
}

// cuenta ya programados (abiertos con fecha) por sede en un día
async function cupoUsado(cedisId, fechaISO) {
  const [[r]] = await pool.query(
    `
    SELECT COUNT(*) AS usados
      FROM mantenimientos
     WHERE cedis_id = ?
       AND fecha_inicio = ?
       AND fecha_fin IS NULL
  `,
    [cedisId || null, fechaISO]
  );
  return Number(r?.usados || 0);
}

// devuelve nombre de la sede por id
async function nombreSede(cedisId) {
  if (!cedisId) return '';
  const [[r]] = await pool.query('SELECT nombre FROM cedis WHERE id=?', [cedisId]);
  return r?.nombre || '';
}

// encuentra la siguiente fecha disponible (>= hoy), evita domingo, respeta capacidad
async function proximaFechaDisponible(cedisId, baseFecha) {
  const sedeNombre = await nombreSede(cedisId);
  const cupo = capacidadDeSede(sedeNombre);

  let f = dayjs(baseFecha);
  if (f.isBefore(dayjs(), 'day')) f = dayjs(); // nunca en el pasado
  f = siguienteHabil(f);

  // busca adelante hasta encontrar día con cupo
  let intentos = 0;
  while (intentos < 365) {
    const fechaISO = f.format('YYYY-MM-DD');
    if (!esDomingo(fechaISO)) {
      const usados = await cupoUsado(cedisId, fechaISO);
      if (usados < cupo) return fechaISO;
    }
    f = f.add(1, 'day');
    intentos++;
  }
  // fallback (no debería llegar)
  return f.format('YYYY-MM-DD');
}

// base por historial simple
function diasBasePorVeces(veces = 0, ultimoTipo = '') {
  let base = 45;
  if (veces >= 3 && veces < 5) base = 40;
  if (veces >= 5) base = 35;
  if (String(ultimoTipo).toUpperCase() === 'CORRECTIVO') base = Math.min(base, 30);
  return base;
}

async function calcularProximaFecha(unidadId, cedisId) {
  // veces que ha entrado
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?',
    [unidadId]
  );

  // último
  const [hist] = await pool.query(
    `
    SELECT id, tipo, fecha_inicio, fecha_fin
      FROM mantenimientos
     WHERE unidad_id=?
     ORDER BY id DESC
     LIMIT 1
  `,
    [unidadId]
  );

  const ultimo = hist?.[0] || null;
  const base = diasBasePorVeces(veces || 0, ultimo?.tipo || '');

  let candidata = ultimo
    ? dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(base, 'day')
    : dayjs().add(base, 'day');

  const fecha = await proximaFechaDisponible(cedisId || null, candidata);
  return fecha; // YYYY-MM-DD
}

/* =========================
   Auth mínimo
========================= */
app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await pool.query(
      `
      SELECT u.id, u.username, u.password_hash, r.nombre AS rol
        FROM usuarios u
        JOIN roles r ON r.id = u.rol_id
       WHERE u.username = ? AND u.activo = 1
    `,
      [username]
    );

    if (!rows?.length) {
      return res.render('login', { title: 'Iniciar sesión', error: 'Usuario o contraseña inválidos' });
    }
    const bcrypt = (await import('bcryptjs')).default;
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) {
      return res.render('login', { title: 'Iniciar sesión', error: 'Usuario o contraseña inválidos' });
    }
    req.session.user = { id: rows[0].id, username: rows[0].username, rol: rows[0].rol };
    res.redirect('/');
  } catch (e) {
    console.error('login error', e);
    res.render('login', { title: 'Iniciar sesión', error: 'No se pudo iniciar sesión' });
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* =========================
   Dashboard
========================= */
app.get('/', async (req, res, next) => {
  try {
    const mes = req.query.mes || dayjs().format('YYYY-MM');
    const ini = dayjs(mes + '-01').format('YYYY-MM-DD');
    const fin = dayjs(mes + '-01').endOf('month').format('YYYY-MM-DD');

    const [[kpis]] = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `
    );

    const [mants] = await pool.query(
      `
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE (m.fecha_inicio BETWEEN ? AND ? OR m.fecha_fin BETWEEN ? AND ?)
       ORDER BY m.id DESC
       LIMIT 10
    `,
      [ini, fin, ini, fin]
    );

    res.render('dashboard', { title: 'Dashboard', kpis, mants, mes });
  } catch (e) {
    next(e);
  }
});

/* =========================
   Unidades
========================= */
app.get('/unidades', async (req, res, next) => {
  try {
    const cedisId = req.query.cedisId || '';
    const placa = (req.query.placa || '').trim();

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let where = '1=1';
    const params = [];
    if (cedisId) {
      where += ' AND u.cedis_id = ?';
      params.push(cedisId);
    }
    if (placa) {
      where += ' AND u.placa LIKE ?';
      params.push(`%${placa}%`);
    }

    const [unidades] = await pool.query(
      `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id = u.cedis_id
       WHERE ${where}
       ORDER BY u.id DESC
    `,
      params
    );

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId, placa });
  } catch (e) {
    next(e);
  }
});

// Programar UNA unidad (por botón)
app.post('/unidades/:id/programar', async (req, res, next) => {
  try {
    const unidadId = Number(req.params.id);
    const [[u]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!u) return res.status(404).send('Unidad no encontrada');

    const fecha = await calcularProximaFecha(u.id, u.cedis_id);
    await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
    `,
      [u.id, u.cedis_id || null, fecha, u.kilometraje || null, req.session.user?.id || null]
    );

    res.redirect('/mantenimientos');
  } catch (e) {
    next(e);
  }
});

/* =========================
   Mantenimientos (abiertos & historial)
========================= */

// Abiertos del MES, filtrables por sede y placa
app.get('/mantenimientos', async (req, res, next) => {
  try {
    const mes = req.query.mes || dayjs().format('YYYY-MM');
    const cedisId = req.query.cedisId || '';
    const placa = (req.query.placa || '').trim();

    const inicio = dayjs(mes + '-01').format('YYYY-MM-DD');
    const fin = dayjs(mes + '-01').endOf('month').format('YYYY-MM-DD');

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let where = `m.fecha_fin IS NULL AND (m.fecha_inicio BETWEEN ? AND ?)`;
    const params = [inicio, fin];

    if (cedisId) {
      where += ' AND m.cedis_id = ?';
      params.push(cedisId);
    }
    if (placa) {
      where += ' AND u.placa LIKE ?';
      params.push(`%${placa}%`);
    }

    const [abiertos] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE ${where}
       ORDER BY m.fecha_inicio ASC, m.id DESC
    `,
      params
    );

    res.render('mantenimientos_list', {
      title: 'Mantenimientos abiertos',
      mants: abiertos,
      cedis,
      cedisId,
      placa,
      mes,
    });
  } catch (e) {
    next(e);
  }
});

// Historial (cerrados)
app.get('/historial', async (req, res, next) => {
  try {
    const [cerrados] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NOT NULL
       ORDER BY m.fecha_fin DESC, m.id DESC
    `
    );
    res.render('historial', { title: 'Historial', mants: cerrados });
  } catch (e) {
    next(e);
  }
});

// Historial por placa
app.get('/historial/:placa', async (req, res, next) => {
  try {
    const placa = req.params.placa.toUpperCase();
    const [rows] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE u.placa = ?
       ORDER BY m.id DESC
    `,
      [placa]
    );
    res.render('historial_placa', { title: `Historial ${placa}`, mants: rows, placa });
  } catch (e) {
    next(e);
  }
});

/* =========================
   Acciones sobre mantenimientos
========================= */

// Cerrar y reprogramar (POST) — evita tocar 'duracion_dias' si es columna generada
// Espera body opcional: { trabajos: [string], comentario: string }
app.post('/mantenimientos/:id/realizado', async (req, res, next) => {
  try {
    const mantId = Number(req.params.id);
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');

    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();
    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // 1) Cerrar (sin escribir duracion_dias si es generada)
    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin = ?, reservado_inventario = 0, motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id = ?
    `,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    // 2) Liberar unidad si no hay otros abiertos
    const [[rowU]] = await pool.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    const unidadId = rowU?.unidad_id;
    if (unidadId) {
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [unidadId]
      );
      if ((ab?.abiertos || 0) === 0) {
        await pool.query("UPDATE unidades SET estado='ACTIVA' WHERE id=?", [unidadId]);
      }
    }

    // 3) Reprogramar preventivo automático
    if (unidadId) {
      const fechaProgramada = await calcularProximaFecha(unidadId, mant.cedis_id || null);
      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [
          unidadId,
          mant.cedis_id || null,
          fechaProgramada,
          mant.km_al_entrar || null,
          req.session.user?.id || null,
        ]
      );
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    next(e);
  }
});

// Eliminar mantenimiento
app.post('/mantenimientos/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [id]);
    res.redirect('/mantenimientos');
  } catch (e) {
    next(e);
  }
});

// Programar por SEDE (todas las unidades activas sin un mantenimiento abierto)
app.post('/cedis/:id/programar', async (req, res, next) => {
  try {
    const cedisId = Number(req.params.id);

    // unidades activas de esa sede
    const [unidades] = await pool.query(
      `
      SELECT u.*
        FROM unidades u
       WHERE u.cedis_id = ?
         AND (u.estado IS NULL OR u.estado <> 'INACTIVA')
    `,
      [cedisId]
    );

    for (const u of unidades) {
      // si ya tiene un abierto, saltar
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [u.id]
      );
      if (Number(ab?.abiertos || 0) > 0) continue;

      const fecha = await calcularProximaFecha(u.id, cedisId);
      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [u.id, cedisId, fecha, u.kilometraje || null, req.session.user?.id || null]
      );
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    next(e);
  }
});

/* =========================
   API útiles
========================= */
app.get('/api/mantenimientos/proximos', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.placa, c.nombre AS cedis,
             COALESCE(m.fecha_fin, m.fecha_inicio) AS ultima_fecha,
             DATE_ADD(COALESCE(m.fecha_fin, m.fecha_inicio), INTERVAL 45 DAY) AS proxima_fecha
        FROM (SELECT unidad_id, MAX(id) AS mid FROM mantenimientos GROUP BY unidad_id) t
        JOIN mantenimientos m ON m.id = t.mid
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       ORDER BY proxima_fecha ASC
       LIMIT 10
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo calcular próximos' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/debug/db', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT 1 AS ok');
    res
      .status(200)
      .send(
        `DB OK -> host=${dbCfg.host} port=${dbCfg.port} db=${dbCfg.database} ssl=${dbCfg.sslEnabled} | result=${JSON.stringify(
          r
        )}`
      );
  } catch (e) {
    res
      .status(500)
      .send(
        `DB ERROR -> host=${dbCfg.host} port=${dbCfg.port} db=${dbCfg.database} ssl=${dbCfg.sslEnabled} | ${e.message}`
      );
  }
});

/* =========================
   Manejo de errores
========================= */
app.use((err, req, res, _next) => {
  console.error('🔥 Unhandled error:', err);
  try {
    res.status(500).render('error', {
      title: 'Error',
      message: err?.message || 'Error interno',
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
      mants: [], // por si la vista espera mants
    });
  } catch {
    res.status(500).send(err?.message || 'Error interno');
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
