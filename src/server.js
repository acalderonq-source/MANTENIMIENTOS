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
   VISTAS & MIDDLEWARES
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

// helpers para vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* =========================
   REGLAS DE PROGRAMACIÓN
========================= */

// 1) Regla base por historial
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 35;
  if (veces >= 3) return 40;
  return 45;
}
function esDomingo(d) {
  const x = dayjs(d);
  return x.day() === 0; // 0=domingo
}
function normalizaFuturo(base) {
  let f = dayjs(base);
  if (f.isBefore(dayjs(), 'day')) f = dayjs().add(1, 'day');
  if (esDomingo(f)) f = f.add(1, 'day');
  return f;
}
function colisiona7Dias(iso, setFechas) {
  const c = dayjs(iso);
  for (const val of setFechas) {
    const d = dayjs(val);
    const diff = Math.abs(c.diff(d, 'day'));
    if (diff < 7) return true;
  }
  return false;
}

// 2) Talleres por cede: Cartago + Transportadora comparten 5/día; demás 1/día
async function getCedeById(id) {
  const [[c]] = await pool.query('SELECT id, nombre FROM cedis WHERE id=?', [id]);
  return c || null;
}

async function resolveWorkshopKey(cedisId) {
  if (!cedisId) return 'WORK_OTHER';
  const c = await getCedeById(cedisId);
  const name = (c?.nombre || '').toLowerCase();
  const isCartago = name.includes('cartago');
  const isTransportadora = name.includes('transportadora');
  if (isCartago || isTransportadora) return 'WORK_CARTAGO_TRANSP';
  return `WORK_${cedisId}`;
}

// Devuelve {workshopKey, cedisIds, maxPorDia}
async function workshopInfo(cedisId) {
  const key = await resolveWorkshopKey(cedisId);
  if (key === 'WORK_CARTAGO_TRANSP') {
    const [rows] = await pool.query(
      `SELECT id FROM cedis WHERE LOWER(nombre) LIKE '%cartago%' OR LOWER(nombre) LIKE '%transportadora%'`
    );
    const ids = (rows || []).map((r) => r.id);
    return { workshopKey: key, cedisIds: ids, maxPorDia: 5 };
  }
  return { workshopKey: key, cedisIds: cedisId ? [cedisId] : [], maxPorDia: 1 };
}

// 3) Calendario del taller: set de fechas y conteo por día
async function fechasProgramadasPorDia({ cedisId = null } = {}) {
  const { cedisIds, maxPorDia } = await workshopInfo(cedisId);
  let sql = `
    SELECT DATE(m.fecha_inicio) d, COUNT(*) cnt
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
     WHERE m.fecha_fin IS NULL
       AND m.fecha_inicio IS NOT NULL
  `;
  const args = [];
  if (cedisIds.length) {
    sql += ` AND u.cedis_id IN (${cedisIds.map(() => '?').join(',')})`;
    args.push(...cedisIds);
  }
  sql += ' GROUP BY DATE(m.fecha_inicio)';
  const [rows] = await pool.query(sql, args);
  const map = new Map();
  for (const r of rows || []) map.set(dayjs(r.d).format('YYYY-MM-DD'), Number(r.cnt));
  return { porDia: map, maxPorDia };
}

async function setFechasProgramadas({ cedisId = null } = {}) {
  const { cedisIds } = await workshopInfo(cedisId);
  let sql = `
    SELECT m.fecha_inicio
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
     WHERE m.fecha_fin IS NULL
       AND m.fecha_inicio IS NOT NULL
  `;
  const args = [];
  if (cedisIds.length) {
    sql += ` AND u.cedis_id IN (${cedisIds.map(() => '?').join(',')})`;
    args.push(...cedisIds);
  }
  const [rows] = await pool.query(sql, args);
  return new Set((rows || []).map((r) => dayjs(r.fecha_inicio).format('YYYY-MM-DD')));
}

async function primerDiaDisponible(base, { cedisId = null } = {}) {
  const set = await setFechasProgramadas({ cedisId });
  const { porDia, maxPorDia } = await fechasProgramadasPorDia({ cedisId });
  let f = normalizaFuturo(base);
  for (let i = 0; i < 180; i++) {
    const iso = f.format('YYYY-MM-DD');
    const cnt = porDia.get(iso) || 0;
    if (!colisiona7Dias(iso, set) && cnt < maxPorDia) return iso;
    f = f.add(1, 'day');
    if (esDomingo(f)) f = f.add(1, 'day');
  }
  return f.format('YYYY-MM-DD'); // fallback
}

// 4) Fecha base por historial + reglas
async function calcularProximaFecha(unidadId, trabajosHechos = [], { cedisId = null } = {}) {
  // veces de la unidad
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?',
    [unidadId]
  );

  // último mantenimiento
  const [hist] = await pool.query(
    `SELECT id, tipo, fecha_inicio, fecha_fin
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
      LIMIT 1`,
    [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist.length ? hist[0] : null;

  let baseDias = diasBasePorVeces(veces || 0);
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    baseDias = Math.min(baseDias, 30);
  }

  // pequeños ajustes por trabajos hechos (preventivos “pesados” => un poco antes)
  const hechos = (Array.isArray(trabajosHechos) ? trabajosHechos : []).map((t) =>
    String(t || '').toLowerCase()
  );
  const pesados = ['cambio de aceite', 'filtro', 'frenos', 'suspensión', 'alineación', 'balanceo'];
  if (hechos.some((h) => pesados.some((p) => h.includes(p)))) {
    baseDias = Math.max(baseDias - 5, 20);
  }

  const baseFecha = ultimo
    ? dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(baseDias, 'day')
    : dayjs().add(baseDias, 'day');

  const fecha = await primerDiaDisponible(baseFecha, { cedisId });
  return fecha; // 'YYYY-MM-DD'
}

/* =========================
   AUTENTICACIÓN SIMPLE
========================= */
app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query(
      `
      SELECT u.id, u.username, u.password_hash, r.nombre AS rol
        FROM usuarios u
        JOIN roles r ON r.id=u.rol_id
       WHERE u.username=? AND u.activo=1
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
   DASHBOARD
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
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id=m.cedis_id
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
   UNIDADES
========================= */
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id || '';
    let sql = `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id=u.cedis_id
       WHERE 1=1
    `;
    const args = [];
    if (cedisId) {
      sql += ' AND u.cedis_id = ?';
      args.push(cedisId);
    }
    sql += ' ORDER BY u.id DESC';
    const [unidades] = await pool.query(sql, args);
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

// Programar UNA unidad por IA
app.post('/unidades/:id/programar', async (req, res) => {
  const unidadId = Number(req.params.id);
  try {
    const [[u]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!u) return res.status(404).send('Unidad no encontrada');

    const fecha = await calcularProximaFecha(unidadId, [], { cedisId: u.cedis_id || null });
    const asignada = await primerDiaDisponible(fecha, { cedisId: u.cedis_id || null });

    const [r] = await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
    `,
      [unidadId, u.cedis_id || null, asignada, u.kilometraje || null, req.session.user?.id || null]
    );

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).send('No se pudo programar la unidad');
  }
});

/* =========================
   MANTENIMIENTOS
========================= */
app.get('/mantenimientos', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id || '';
    let sql = `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NULL
    `;
    const args = [];
    if (cedisId) {
      sql += ' AND u.cedis_id = ?';
      args.push(cedisId);
    }
    sql += ' ORDER BY m.fecha_inicio IS NULL DESC, m.fecha_inicio ASC, m.id DESC';
    const [abiertos] = await pool.query(sql, args);

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');
    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos, cedis, cedisId });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// Programar TODAS las unidades ACTIVA de una CEDE
app.post('/mantenimientos/programar-cede', async (req, res) => {
  try {
    const cedisId = Number(req.body.cedis_id || 0);
    if (!cedisId) return res.status(400).send('cedis_id requerido');

    const [unidades] = await pool.query(
      `SELECT * FROM unidades WHERE cedis_id=? AND estado='ACTIVA' ORDER BY id`,
      [cedisId]
    );

    for (const u of unidades || []) {
      const fechaBase = await calcularProximaFecha(u.id, [], { cedisId });
      const asignada = await primerDiaDisponible(fechaBase, { cedisId });
      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [u.id, cedisId, asignada, u.kilometraje || null, req.session.user?.id || null]
      );
    }

    res.redirect('/mantenimientos?cedis_id=' + cedisId);
  } catch (e) {
    console.error('programar cede error', e);
    res.status(500).send('No se pudo programar la cede');
  }
});

// Cerrar “Se realizó” + reprogramar
// body: { trabajos: [string], comentario: string }
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();

    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // OJO: NO setear duracion_dias si es columna generada en MySQL (evita tu error)
    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin=?,
             reservado_inventario=0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id=?
    `,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    // Liberar unidad si ya no tiene abiertos
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

      // Reprogramar preventivo
      const fechaProg = await calcularProximaFecha(unidadId, trabajos, { cedisId: mant.cedis_id || null });
      const asignada = await primerDiaDisponible(fechaProg, { cedisId: mant.cedis_id || null });

      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [unidadId, mant.cedis_id || null, asignada, mant.km_al_entrar || null, req.session.user?.id || null]
      );
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// ELIMINAR un mantenimiento CERRADO (lo que pediste)
app.delete('/mantenimientos/:id', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    const [[m]] = await pool.query('SELECT id, fecha_fin FROM mantenimientos WHERE id=?', [mantId]);
    if (!m) return res.status(404).send('No existe');

    if (!m.fecha_fin) {
      return res.status(400).send('Solo se pueden eliminar mantenimientos ya realizados (cerrados).');
    }
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [mantId]);
    res.redirect('/historial');
  } catch (e) {
    console.error('eliminar cerrado error', e);
    res.status(500).send('No se pudo eliminar el mantenimiento cerrado');
  }
});

/* =========================
   HISTORIAL
========================= */
app.get('/historial', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id || '';
    let sql = `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id=m.cedis_id
       WHERE m.fecha_fin IS NOT NULL
    `;
    const args = [];
    if (cedisId) {
      sql += ' AND u.cedis_id = ?';
      args.push(cedisId);
    }
    sql += ' ORDER BY m.fecha_fin DESC, m.id DESC';
    const [cerrados] = await pool.query(sql, args);
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('historial', { title: 'Historial', mants: cerrados, cedis, cedisId });
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
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id=m.cedis_id
       WHERE u.placa=?
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
   API AUX
========================= */
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/debug/db', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT 1 AS ok');
    res
      .status(200)
      .send(
        `DB OK -> host=${dbCfg.host} port=${dbCfg.port} db=${dbCfg.database} ssl=${dbCfg.sslEnabled} | ${JSON.stringify(
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
   START
========================= */
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`✅ Servidor en http://${HOST}:${PORT}`);
});
