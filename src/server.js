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
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App base ----------
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

// Helpers
app.use((req, res, next) => {
  res.locals.user = req.session.user || { username: 'admin' }; // demo
  res.locals.dayjs = dayjs;
  next();
});

// ---------- LOGIN mínimo (demo) ----------
app.get('/login', (req, res) => {
  res.render('login', { title: 'Iniciar sesión' });
});
app.post('/login', (req, res) => {
  // demo sin DB de usuarios
  const { username, password } = req.body;
  if (username && password) {
    req.session.user = { username, rol: 'ADMIN' };
    return res.redirect('/');
  }
  res.render('login', { title: 'Iniciar sesión', error: 'Usuario o contraseña inválidos' });
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- DASHBOARD sencillo ----------
app.get('/', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);

    const [mants] = await pool.query(`
      SELECT m.id,u.placa,c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin, m.duracion_dias
        FROM mantenimientos m
        JOIN unidades u ON u.id=m.unidad_id
   LEFT JOIN cedis c ON c.id=m.cedis_id
    ORDER BY m.id DESC LIMIT 10
    `);

    res.render('dashboard', { title: 'Dashboard', kpis, mants });
  } catch (e) {
    console.error('dashboard error', e);
    res.render('dashboard', { title: 'Dashboard', kpis: { unidades: 0, en_taller: 0, hoy: 0 }, mants: [] });
  }
});

// ---------- Helpers de fechas ----------
async function siguienteDiaLibre(fechaISO) {
  // evita domingos y evita 2 mantenimientos el mismo día (global)
  let f = dayjs(fechaISO);
  if (f.day() === 0) f = f.add(1, 'day'); // domingo -> lunes

  // avanza si el día está ocupado
  // si quieres evitar colisión "por CEDIS" añade AND cedis_id=? en el SELECT
  // y pásalo como parámetro.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const fechaStr = f.format('YYYY-MM-DD');
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM mantenimientos
        WHERE DATE(fecha_inicio)=?`,
      [fechaStr]
    );
    const taken = Array.isArray(rows) ? (rows[0]?.n || 0) : 0;
    if (taken === 0 && f.day() !== 0) return fechaStr;
    f = f.add(1, 'day');
  }
}

async function calcularFechaProgramada(unidadId) {
  // base: 45 días desde último cierre (o desde hoy)
  let base = dayjs();
  const [hist] = await pool.query(
    `SELECT COALESCE(fecha_fin, fecha_inicio) AS f
       FROM mantenimientos
      WHERE unidad_id=?
   ORDER BY id DESC
      LIMIT 1`,
    [unidadId]
  );
  if (Array.isArray(hist) && hist.length && hist[0].f) {
    base = dayjs(hist[0].f);
  }
  const propuesta = base.add(45, 'day').format('YYYY-MM-DD');
  return siguienteDiaLibre(propuesta);
}

// ---------- UNIDADES (filtradas por CEDIS) ----------
app.get('/unidades', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const cedisId = req.query.cedis_id ? Number(req.query.cedis_id) : null;

  const [cedis] = await pool.query(`SELECT id, nombre FROM cedis ORDER BY nombre`);
  const params = [];
  let sql = `
    SELECT u.*, c.nombre AS cedis_nombre
      FROM unidades u
 LEFT JOIN cedis c ON c.id=u.cedis_id
  `;

  if (cedisId) {
    sql += ` WHERE u.cedis_id=?`;
    params.push(cedisId);
  }
  sql += ` ORDER BY u.placa`;

  const [unidades] = await pool.query(sql, params);

  res.render('unidades', {
    title: 'Unidades',
    cedis: Array.isArray(cedis) ? cedis : [],
    unidades: Array.isArray(unidades) ? unidades : [],
    cedisId,
  });
});

// API para filtrar unidades (si prefieres cargar por fetch en la vista)
app.get('/api/unidades', async (req, res) => {
  const cedisId = req.query.cedis_id ? Number(req.query.cedis_id) : null;
  const params = [];
  let sql = `
    SELECT u.*, c.nombre AS cedis_nombre
      FROM unidades u
 LEFT JOIN cedis c ON c.id=u.cedis_id
  `;
  if (cedisId) {
    sql += ` WHERE u.cedis_id=?`;
    params.push(cedisId);
  }
  sql += ` ORDER BY u.placa`;
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

// ---------- Programar PREVENTIVO por unidad ----------
app.post('/unidades/:id/programar', async (req, res) => {
  try {
    if (!req.session.user) return res.redirect('/login');

    const unidadId = Number(req.params.id);
    const { cedis_id, trabajos = [] } = req.body;

    // cargar unidad
    const [uRows] = await pool.query(`SELECT * FROM unidades WHERE id=?`, [unidadId]);
    const unidad = Array.isArray(uRows) && uRows[0] ? uRows[0] : null;
    if (!unidad) return res.status(404).send('Unidad no encontrada');

    // motivo (lo que selecciones en la vista)
    const lista = Array.isArray(trabajos) ? trabajos : [trabajos].filter(Boolean);
    const motivo =
      lista.length > 0 ? `Preventivo: ${lista.join(', ')}` : 'Plan preventivo sugerido';

    const fecha = await calcularFechaProgramada(unidadId);

    await pool.query(
      `INSERT INTO mantenimientos
       (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
       VALUES (?,?,?,?,?,?,1,?)`,
      [
        unidadId,
        cedis_id || unidad.cedis_id || null,
        'PREVENTIVO',
        motivo,
        fecha,
        unidad.kilometraje || null,
        1, // creado_por (demo)
      ]
    );

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).send('No se pudo programar el mantenimiento.');
  }
});

// ---------- Lista de mantenimientos (simple) ----------
app.get('/mantenimientos', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const [rows] = await pool.query(`
    SELECT m.*, u.placa, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
 LEFT JOIN cedis c ON c.id=m.cedis_id
  ORDER BY m.id DESC
  `);
  res.render('mantenimientos_list', { title: 'Mantenimientos', mants: rows });
});

// ---------- Cerrar y reprogramar en automático ----------
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const hoy = dayjs().format('YYYY-MM-DD');

    // cerrar
    await pool.query(
      `UPDATE mantenimientos
          SET fecha_fin=?, duracion_dias = DATEDIFF(?, fecha_inicio), reservado_inventario=0
        WHERE id=?`,
      [hoy, hoy, id]
    );

    // buscar unidad
    const [[row]] = await pool.query(`SELECT unidad_id FROM mantenimientos WHERE id=?`, [id]);
    if (row?.unidad_id) {
      // reprogramar próximo preventivo
      const fecha = await calcularFechaProgramada(row.unidad_id);
      await pool.query(
        `INSERT INTO mantenimientos
         (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         SELECT unidad_id, cedis_id, 'PREVENTIVO', 'Plan preventivo sugerido', ?, NULL, 1, 1
           FROM mantenimientos WHERE id=?`,
        [fecha, id]
      );
      // liberar unidad (si no hay abiertos)
      const [[abiertos]] = await pool.query(
        `SELECT COUNT(*) AS n FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL`,
        [row.unidad_id]
      );
      if ((abiertos?.n || 0) === 0) {
        await pool.query(`UPDATE unidades SET estado='ACTIVA' WHERE id=?`, [row.unidad_id]);
      }
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar.');
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Servidor en http://localhost:${PORT}`)
);
