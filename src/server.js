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
   Vistas y middlewares
========================= */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
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

// Helpers a vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* =========================
   Reglas de IA (heurística)
========================= */

// Regla base por cantidad de entradas
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 35;
  if (veces >= 3) return 40;
  return 45;
}

// ¿Es domingo?
function esDomingo(iso) {
  return dayjs(iso).day() === 0; // 0=domingo
}

// Mueve al siguiente día hábil (evita domingo)
function siguienteHabil(iso) {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}

// Lee todas las fechas ya programadas (abiertas con fecha_inicio)
async function obtenerFechasProgramadas() {
  const [rows] = await pool.query(`
    SELECT fecha_inicio
      FROM mantenimientos
     WHERE fecha_fin IS NULL
       AND fecha_inicio IS NOT NULL
  `);
  return new Set(
    (rows || [])
      .map((r) => r.fecha_inicio)
      .filter(Boolean)
      .map((f) => dayjs(f).format('YYYY-MM-DD'))
  );
}

// Evita colisiones a ±6 días de lo ya programado (espaciado >=7)
function espaciar7dias(fechaISO, setFechas) {
  let f = dayjs(fechaISO);
  const colisiona = (cand) => {
    const c = dayjs(cand);
    for (const val of setFechas) {
      const d = dayjs(val);
      const diff = Math.abs(c.diff(d, 'day'));
      if (diff < 7) return true;
    }
    return false;
  };
  while (esDomingo(f) || colisiona(f)) {
    f = f.add(1, 'day');
  }
  return f;
}

// “Qué se le hizo” → ajuste de días recomendado
// (Puedes tunear estos pesos por tu operación)
function ajustePorTrabajo(trabajos = []) {
  const t = (trabajos || []).map((s) => String(s || '').toLowerCase());
  let delta = 0;
  if (t.some((x) => x.includes('aceite'))) delta = Math.max(delta, 45);
  if (t.some((x) => x.includes('filtro'))) delta = Math.max(delta, 45);
  if (t.some((x) => x.includes('fren'))) delta = Math.max(delta, 30);
  if (t.some((x) => x.includes('llanta'))) delta = Math.max(delta, 60);
  if (t.some((x) => x.includes('correa') || x.includes('banda'))) delta = Math.max(delta, 90);
  // default si nada matchea
  if (delta === 0) delta = 45;
  return delta;
}

// Calcula próxima fecha preventiva para una unidad
// - Usa “veces que entró”, “último tipo”, y (opcional) trabajos hechos
async function calcularProximaFecha(unidadId, trabajosHechos = []) {
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?',
    [unidadId]
  );

  const [hist] = await pool.query(
    `SELECT id, tipo, fecha_inicio, fecha_fin
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
      LIMIT 1`,
    [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist.length ? hist[0] : null;

  // base por historial
  let dias = diasBasePorVeces(veces || 0);
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    dias = Math.min(dias, 30);
  }

  // ajuste por trabajos realizados
  const diasTrabajo = ajustePorTrabajo(trabajosHechos);
  dias = Math.min(Math.max(dias, 30), Math.max(dias, diasTrabajo)); // combina con base

  // baseDate: último fin o inicio; si no hay historial, hoy
  let baseDate = ultimo ? (ultimo.fecha_fin || ultimo.fecha_inicio) : dayjs().format('YYYY-MM-DD');

  let sugerida = dayjs(baseDate).add(dias, 'day');
  sugerida = siguienteHabil(sugerida);

  const setFechas = await obtenerFechasProgramadas();
  sugerida = espaciar7dias(sugerida, setFechas);

  return sugerida.format('YYYY-MM-DD');
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
app.get('/', async (req, res) => {
  try {
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
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
    console.error('dashboard error', e);
    res.status(500).send('Error cargando dashboard');
  }
});

/* =========================
   Unidades (con filtro por cede)
========================= */
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id ? Number(req.query.cedis_id) : null;

    let sql = `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id = u.cedis_id
    `;
    const params = [];
    if (cedisId) {
      sql += ` WHERE u.cedis_id = ?`;
      params.push(cedisId);
    }
    sql += ` ORDER BY u.id DESC`;

    const [unidades] = await pool.query(sql, params);
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

// Programar 1 unidad (POST)
app.post('/unidades/:id/programar', async (req, res) => {
  try {
    const unidadId = Number(req.params.id);
    const [[unidad]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!unidad) return res.status(404).send('Unidad no encontrada');

    // trabajos opcionales para influir la fecha
    const trabajos = Array.isArray(req.body.trabajos) ? req.body.trabajos : [];

    const fecha = await calcularProximaFecha(unidadId, trabajos);
    await pool.query(
      `INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
       VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
      [unidadId, unidad.cedis_id || null, fecha, unidad.kilometraje || null, req.session.user?.id || null]
    );

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).send('No se pudo programar la unidad');
  }
});

// Programar TODA una cede (POST)
app.post('/unidades/programar-cede', async (req, res) => {
  try {
    const cedisId = Number(req.body.cedis_id);
    if (!cedisId) return res.status(400).send('cedis_id requerido');

    const [unidades] = await pool.query('SELECT * FROM unidades WHERE cedis_id=? ORDER BY placa', [cedisId]);
    for (const u of unidades) {
      const fecha = await calcularProximaFecha(u.id, []);
      await pool.query(
        `INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
        [u.id, u.cedis_id || null, fecha, u.kilometraje || null, req.session.user?.id || null]
      );
    }
    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('programar cede error', e);
    res.status(500).send('No se pudo programar la cede');
  }
});

/* =========================
   Mantenimientos
========================= */

// Abiertos (con filtro por cede)
app.get('/mantenimientos', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id ? Number(req.query.cedis_id) : null;

    let sql = `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NULL
    `;
    const params = [];
    if (cedisId) {
      sql += ` AND m.cedis_id = ?`;
      params.push(cedisId);
    }
    sql += ` ORDER BY m.id DESC`;

    const [abiertos] = await pool.query(sql, params);
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos, cedis, cedisId });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// Cerrar “Se realizó” (guarda trabajos, comentario y reprograma)
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  try {
    const mantId = Number(req.params.id);
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();

    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // ⚠️ No tocar duracion_dias si es columna generada!
    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin = ?,
             reservado_inventario = 0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id = ?
    `,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    // Liberar unidad si no tiene otros abiertos
    const [[rowU]] = await pool.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    const unidadId = rowU?.unidad_id;
    if (unidadId) {
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [unidadId]
      );
      if ((ab?.abiertos || 0) === 0) {
        await pool.query(`UPDATE unidades SET estado='ACTIVA' WHERE id=?`, [unidadId]);
      }

      // Reprogramar con IA (heurística de trabajos) evitando domingos y espaciado global
      const fecha = await calcularProximaFecha(unidadId, trabajos);
      await pool.query(
        `INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
        [unidadId, mant.cedis_id || null, fecha, mant.km_al_entrar || null, req.session.user?.id || null]
      );
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// Eliminar mantenimiento
app.post('/mantenimientos/:id/eliminar', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [id]);
    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('eliminar mant error', e);
    res.status(500).send('No se pudo eliminar');
  }
});

/* =========================
   Historial
========================= */
app.get('/historial', async (req, res) => {
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
    console.error('historial error', e);
    res.status(500).send('No se pudo cargar historial');
  }
});

app.get('/historial/:placa', async (req, res) => {
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
    console.error('historial placa error', e);
    res.status(500).send('No se pudo cargar historial por placa');
  }
});

/* =========================
   APIs auxiliares
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
    console.error('api proximos error', e);
    res.status(500).json({ error: 'No se pudo calcular próximos' });
  }
});

/* =========================
   Diagnóstico
========================= */
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
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
