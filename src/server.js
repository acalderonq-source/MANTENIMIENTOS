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

/* ==========================
   Vistas y middlewares
========================== */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false
}));

// Helpers a vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* ==========================
   Utilidades de fecha / IA reglas
========================== */

// capacidad por CEDIS (nombre). Cartago y Transportadora → 5 / día, otros 1 / día.
function capacidadPorCedisNombre(nombre = '') {
  const n = String(nombre || '').toLowerCase();
  if (n.includes('cartago') || n.includes('transportadora')) return 5;
  return 1;
}

// trae nombre cedis por id (cache simple en llamada)
async function nombreCedis(cedisId) {
  if (!cedisId) return null;
  const [[row]] = await pool.query('SELECT nombre FROM cedis WHERE id=?', [cedisId]);
  return row?.nombre || null;
}

// domingo?
function esDomingo(iso) {
  return dayjs(iso).day() === 0;
}
// siguiente hábil (evitar domingo)
function siguienteHabil(iso) {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}

// cuenta programados abiertos de un CEDIS para una fecha
async function conteoDiaCedis(cedisId, fechaISO) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM mantenimientos
      WHERE cedis_id = ?
        AND fecha_fin IS NULL
        AND DATE(fecha_inicio) = DATE(?)`,
    [cedisId || null, fechaISO]
  );
  return r?.n || 0;
}

// obtiene fechas ya programadas (abiertos con fecha_inicio)
async function setFechasProgramadas() {
  const [rows] = await pool.query(`
    SELECT fecha_inicio
      FROM mantenimientos
     WHERE fecha_fin IS NULL
       AND fecha_inicio IS NOT NULL
  `);
  return new Set(
    (rows || [])
      .map(r => r.fecha_inicio)
      .filter(Boolean)
      .map(f => dayjs(f).format('YYYY-MM-DD'))
  );
}

// evita colisiones a ±6 días respecto a fechas ya programadas (espaciado global)
function colisiona7dias(candISO, fechasSet) {
  const c = dayjs(candISO);
  for (const val of fechasSet) {
    const d = dayjs(val);
    const diff = Math.abs(c.diff(d, 'day'));
    if (diff < 7) return true;
  }
  return false;
}

// calcula próxima fecha de un mantenimiento en base a historial + capacidad por cede
async function calcularProximaFecha(unidadId, preferCedisId = null) {
  // veces que ha entrado
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?', [unidadId]
  );

  // último mantenimiento
  const [hist] = await pool.query(`
    SELECT id, tipo, fecha_inicio, fecha_fin, cedis_id
      FROM mantenimientos
     WHERE unidad_id=?
     ORDER BY id DESC
     LIMIT 1
  `, [unidadId]);
  const ultimo = hist?.[0] || null;

  // base días
  let baseDias = 45;
  if (veces >= 5) baseDias = 35;
  else if (veces >= 3) baseDias = 40;
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    baseDias = Math.min(baseDias, 30);
  }

  let base = ultimo ? dayjs(ultimo.fecha_fin || ultimo.fecha_inicio) : dayjs();
  base = base.add(baseDias, 'day');

  // reglas globales
  const fechasSet = await setFechasProgramadas();

  // buscar primer día que cumpla:
  // - no domingo
  // - no colisionar ±6 días con otros programados
  // - no exceder capacidad del CEDIS del mantenimiento (si hay cedis)
  // - no extenderse demasiado (máx +120 días desde base por seguridad)
  let d = siguienteHabil(base);
  const cedisId = preferCedisId ?? ultimo?.cedis_id ?? null;
  const cedisNombre = await nombreCedis(cedisId);
  const capacidad = capacidadPorCedisNombre(cedisNombre);
  for (let i = 0; i < 180; i++) {
    const iso = d.format('YYYY-MM-DD');
    if (!colisiona7dias(iso, fechasSet) && !esDomingo(iso)) {
      if (!cedisId) {
        return iso; // sin cede asociada, aceptamos fecha
      }
      const n = await conteoDiaCedis(cedisId, iso);
      if (n < capacidad) return iso;
    }
    d = d.add(1, 'day');
  }
  // fallback si no encontramos antes
  return d.format('YYYY-MM-DD');
}

/* ==========================
   Auth mínimo
========================== */
app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.password_hash, r.nombre AS rol
        FROM usuarios u
        JOIN roles r ON r.id = u.rol_id
       WHERE u.username = ? AND u.activo = 1
    `, [username]);

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

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ==========================
   Dashboard
========================== */
app.get('/', async (req, res, next) => {
  try {
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades)                              AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);
    const [mants] = await pool.query(`
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin, m.duracion_dias
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       ORDER BY m.id DESC
       LIMIT 10
    `);
    res.render('dashboard', { title: 'Dashboard', kpis, mants });
  } catch (e) {
    next(e);
  }
});

/* ==========================
   Unidades
========================== */
app.get('/unidades', async (req, res, next) => {
  try {
    const cedisId = (req.query.cedis_id || '').trim();
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let sql = `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id=u.cedis_id
       WHERE 1=1
    `;
    const params = [];
    if (cedisId) {
      sql += ' AND u.cedis_id = ?';
      params.push(cedisId);
    }
    sql += ' ORDER BY u.id DESC';
    const [unidades] = await pool.query(sql, params);

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId });
  } catch (e) {
    next(e);
  }
});

/* ==========================
   Mantenimientos
========================== */
app.get('/mantenimientos', async (req, res, next) => {
  try {
    const cedisId = (req.query.cedis_id || '').trim();

    const [cedis] = await pool.query('SELECT id, nombre FROM cedis ORDER BY nombre');

    let sql = `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NULL
    `;
    const params = [];
    if (cedisId) {
      sql += ' AND m.cedis_id = ?';
      params.push(cedisId);
    }
    sql += ' ORDER BY m.fecha_inicio IS NULL DESC, m.fecha_inicio ASC, m.id DESC';

    const [mants] = await pool.query(sql, params);

    res.render('mantenimientos_list', {
      title: 'Mantenimientos abiertos',
      mants,
      cedis,
      cedisId
    });
  } catch (e) {
    next(e);
  }
});

// Historial general
app.get('/historial', async (req, res, next) => {
  try {
    const [cerrados] = await pool.query(`
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NOT NULL
       ORDER BY m.fecha_fin DESC, m.id DESC
    `);
    res.render('historial', { title: 'Historial', mants: cerrados });
  } catch (e) {
    next(e);
  }
});

// Historial por placa
app.get('/historial/:placa', async (req, res, next) => {
  try {
    const placa = req.params.placa.toUpperCase();
    const [rows] = await pool.query(`
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE u.placa = ?
       ORDER BY m.id DESC
    `, [placa]);
    res.render('historial_placa', { title: `Historial ${placa}`, mants: rows, placa });
  } catch (e) {
    next(e);
  }
});

/* Cerrar/realizado + reprogramar (POST)
   La vista envía: trabajos[] y comentario
*/
app.post('/mantenimientos/:id/realizado', async (req, res, next) => {
  const mantId = Number(req.params.id);
  try {
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();

    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // NO tocar duracion_dias si es columna generada; solo fecha_fin + reservado
    await pool.query(`
      UPDATE mantenimientos
         SET fecha_fin=?,
             reservado_inventario=0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id=?
    `, [hoy, hechoTxt, comentarioTxt, mantId]);

    // liberar unidad si no tiene otros abiertos
    const [[rowUnidad]] = await pool.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    const unidadId = rowUnidad?.unidad_id;
    if (unidadId) {
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [unidadId]
      );
      if ((ab?.abiertos || 0) === 0) {
        await pool.query("UPDATE unidades SET estado='ACTIVA' WHERE id=?", [unidadId]);
      }
    }

    // Reprogramar preventivo automático (usa reglas de capacidad por CEDIS)
    if (unidadId) {
      const fechaProgramada = await calcularProximaFecha(unidadId, mant.cedis_id || null);
      await pool.query(`
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', ?, ?, ?, 1, ?)
      `, [
        unidadId,
        mant.cedis_id || null,
        'Plan preventivo sugerido',
        fechaProgramada,
        mant.km_al_entrar || null,
        req.session.user?.id || null
      ]);
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

// Programar TODOS los de un CEDIS (masivo)
app.post('/mantenimientos/programar-cedis', async (req, res, next) => {
  try {
    const cedisId = (req.body.cedis_id || req.query.cedis_id || '').trim();
    if (!cedisId) return res.redirect('/mantenimientos');

    const [unidades] = await pool.query(
      'SELECT id FROM unidades WHERE cedis_id = ? AND estado="ACTIVA" ORDER BY id',
      [cedisId]
    );

    for (const u of (unidades || [])) {
      const fecha = await calcularProximaFecha(u.id, cedisId);
      await pool.query(`
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Programado masivo por CEDIS', ?, 1, ?)
      `, [u.id, cedisId, fecha, req.session.user?.id || null]);
    }

    res.redirect('/mantenimientos?cedis_id=' + encodeURIComponent(cedisId));
  } catch (e) {
    next(e);
  }
});

/* ==========================
   API auxiliares
========================== */
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
    res.status(200).send(
      `DB OK -> host=${dbCfg.host} port=${dbCfg.port} db=${dbCfg.database} ssl=${dbCfg.sslEnabled} | result=${JSON.stringify(r)}`
    );
  } catch (e) {
    res.status(500).send(
      `DB ERROR -> host=${dbCfg.host} port=${dbCfg.port} db=${dbCfg.database} ssl=${dbCfg.sslEnabled} | ${e.message}`
    );
  }
});

/* ==========================
   Error handler global
========================== */
app.use((err, req, res, next) => {
  console.error('🔥 Unhandled error:', err);
  try {
    res.status(500).render('error', {
      title: 'Error',
      message: 'Ocurrió un error interno en el servidor.',
      detail: process.env.NODE_ENV === 'development' ? (err.stack || String(err)) : null
    });
  } catch {
    res.status(500).send('Internal Server Error');
  }
});

/* ==========================
   Start
========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
