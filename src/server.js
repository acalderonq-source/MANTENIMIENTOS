// src/server.js
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import methodOverride from 'method-override';
import expressLayouts from 'express-ejs-layouts';
import dayjs from 'dayjs';
import { pool } from './db.js';

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------ App ------
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

// Sesión simulada para pruebas
app.use((req, res, next) => {
  if (!req.session.user) {
    req.session.user = { id: 1, username: 'admin', rol: 'ADMIN' };
  }
  res.locals.user = req.session.user;
  res.locals.dayjs = dayjs;
  next();
});

// ------ Utilidades de fecha ------
function esDomingo(iso) { return dayjs(iso).day() === 0; }
function siguienteNoDomingo(iso) {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d.format('YYYY-MM-DD');
}
async function fechaSinChoque(fechaBase, excluirPlaca = null) {
  let d = dayjs(fechaBase);
  while (true) {
    const fecha = d.format('YYYY-MM-DD');
    const [rows] = await pool.query(
      `SELECT u.placa
         FROM mantenimientos m
         JOIN unidades u ON u.id=m.unidad_id
        WHERE m.fecha_fin IS NULL
          AND m.fecha_inicio = ?`,
      [fecha]
    );
    const hayChoque = Array.isArray(rows) && rows.some(r => r.placa !== excluirPlaca);
    if (!hayChoque) return fecha;
    d = d.add(1, 'day');
    if (d.day() === 0) d = d.add(1, 'day'); // salta domingo
  }
}

// ------ Rutas ------
app.get('/', async (req, res) => {
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
});

// Unidades
app.get('/unidades', async (req, res) => {
  const [unidades] = await pool.query(`
    SELECT u.*, c.nombre AS cedis_nombre
      FROM unidades u
      LEFT JOIN cedis c ON c.id=u.cedis_id
     ORDER BY u.placa
  `);
  res.render('unidades', { title: 'Unidades', unidades });
});

app.post('/unidades', async (req, res) => {
  const { placa, tipo, cedis_nombre } = req.body;
  let cedis_id = null;
  if (cedis_nombre) {
    await pool.query(`INSERT IGNORE INTO cedis (nombre) VALUES (?)`, [cedis_nombre]);
    const [[ced]] = await pool.query(`SELECT id FROM cedis WHERE nombre=? LIMIT 1`, [cedis_nombre]);
    cedis_id = ced?.id || null;
  }
  await pool.query(
    `INSERT INTO unidades (placa, tipo, cedis_id, kilometraje, estado)
     VALUES (?,?,?,?,?)`,
    [placa, tipo || 'CAMION', cedis_id, 0, 'ACTIVA']
  );
  res.redirect('/unidades');
});

// Mantenimientos abiertos
app.get('/mantenimientos', async (req, res) => {
  const [mants] = await pool.query(`
    SELECT m.*, u.placa, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
      LEFT JOIN cedis c ON c.id=m.cedis_id
     WHERE m.fecha_fin IS NULL
     ORDER BY m.fecha_inicio ASC, m.id DESC
  `);
  res.render('mantenimientos_list', { title: 'Mantenimientos', mants });
});

// Historial (cerrados)
app.get('/historial', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT m.*, u.placa, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
      LEFT JOIN cedis c ON c.id=m.cedis_id
     WHERE m.fecha_fin IS NOT NULL
     ORDER BY m.fecha_fin DESC, m.id DESC
  `);
  res.render('historial', { title: 'Historial', items: rows });
});

// Historial por placa
app.get('/historial/:placa', async (req, res) => {
  const placa = req.params.placa.toUpperCase();
  const [[u]] = await pool.query(`SELECT id, placa FROM unidades WHERE placa=? LIMIT 1`, [placa]);
  if (!u) return res.status(404).send('Placa no encontrada');
  const [rows] = await pool.query(`
    SELECT m.*, c.nombre AS cedis_nombre
      FROM mantenimientos m
      LEFT JOIN cedis c ON c.id=m.cedis_id
     WHERE m.unidad_id=?
     ORDER BY m.id DESC`, [u.id]);
  res.render('historial_placa', { title: `Historial ${placa}`, placa, items: rows });
});

// Programar preventivo (IA simple)
app.post('/unidades/:id/programar', async (req, res) => {
  const unidadId = Number(req.params.id);

  const [hist] = await pool.query(`
    SELECT fecha_fin, fecha_inicio
      FROM mantenimientos
     WHERE unidad_id=?
     ORDER BY id DESC
     LIMIT 1`, [unidadId]);
  const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;

  let base = ultimo?.fecha_fin || ultimo?.fecha_inicio || dayjs().format('YYYY-MM-DD');
  let candidata = dayjs(base).add(45, 'day').format('YYYY-MM-DD');
  if (esDomingo(candidata)) candidata = siguienteNoDomingo(candidata);
  candidata = await fechaSinChoque(candidata);

  const [[u]] = await pool.query(`SELECT u.id, u.cedis_id FROM unidades u WHERE u.id=?`, [unidadId]);

  await pool.query(
    `INSERT INTO mantenimientos (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
     VALUES (?,?,?,?,?,?,1,?)`,
    [unidadId, u?.cedis_id || null, 'PREVENTIVO', 'Plan preventivo sugerido', candidata, null, req.session.user?.id || null]
  );
  res.redirect('/mantenimientos');
});

// Cerrar y reprogramar
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  const id = Number(req.params.id);
  const { tareas = '', notas = '' } = req.body;
  const hoy = dayjs().format('YYYY-MM-DD');

  await pool.query(`
    UPDATE mantenimientos
       SET fecha_fin=?, duracion_dias=DATEDIFF(?, COALESCE(fecha_inicio, ?))
     WHERE id=?`,
    [hoy, hoy, hoy, id]
  );

  const [[row]] = await pool.query(`SELECT unidad_id FROM mantenimientos WHERE id=?`, [id]);
  if (!row) return res.redirect('/mantenimientos');
  const unidadId = row.unidad_id;

  let candidata = dayjs(hoy).add(45, 'day').format('YYYY-MM-DD');
  if (esDomingo(candidata)) candidata = siguienteNoDomingo(candidata);
  candidata = await fechaSinChoque(candidata);

  const [[u]] = await pool.query(`SELECT u.id, u.cedis_id FROM unidades u WHERE u.id=?`, [unidadId]);
  const motivo = `Preventivo programado. Tareas hechas: ${tareas || 'N/D'}. Notas: ${notas || 'N/D'}`;

  await pool.query(
    `INSERT INTO mantenimientos (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
     VALUES (?,?,?,?,?,?,1,?)`,
    [unidadId, u?.cedis_id || null, 'PREVENTIVO', motivo, candidata, null, req.session.user?.id || null]
  );

  const [[ab]] = await pool.query(
    `SELECT COUNT(*) AS abiertos
       FROM mantenimientos
      WHERE unidad_id=? AND fecha_fin IS NULL`, [unidadId]);
  if (ab.abiertos === 0) {
    await pool.query(`UPDATE unidades SET estado='ACTIVA' WHERE id=?`, [unidadId]);
  }

  res.redirect('/mantenimientos');
});

// Seed TRANSPORTADORA (todas las placas que pediste)
app.get('/seed/transportadora-extra', async (req, res) => {
  try {
    await pool.query(`INSERT IGNORE INTO cedis (nombre) VALUES ('TRANSPORTADORA')`);
    const [[ced]] = await pool.query(`SELECT id FROM cedis WHERE nombre='TRANSPORTADORA' LIMIT 1`);
    const cedisId = ced?.id;

    const placas = [
      'C150804','S25526','C143298','S35797','C153449','S25816','C167058','S35798','C156152','S30811',
      'S35825','C157184','S32586','S36179','C157631','S35741','S36183','C162129','S25772','C162503',
      'S28102','C162985','S28322','C163630','S32587','C164206','S34202','C167020','S35742','C168961',
      'S25513','C169541','S26048','C169804','S27368','C169965','S34193','C170014','S12404','C170751',
      'S19984','C170869','S34194','C170900','S35759','C171297','S23630','C171394','S30815','C173827',
      'S34200','C174021','S35760','C174563','S37248','C174582','S37243','C175547','C178423','C178439',
      'C177959','C164025','C162227'
    ];

    let insertados = 0, existentes = 0;
    for (const placa of placas) {
      const [u] = await pool.query(`SELECT id FROM unidades WHERE placa=? LIMIT 1`, [placa]);
      if (Array.isArray(u) && u.length) { existentes++; continue; }
      await pool.query(
        `INSERT INTO unidades (placa, tipo, cedis_id, kilometraje, estado)
         VALUES (?,?,?,?,?)`,
        [placa, placa.startsWith('S') ? 'SEMIRREMOLQUE' : 'CAMION', cedisId, 0, 'ACTIVA']
      );
      insertados++;
    }

    res.send(`✅ TRANSPORTADORA extra: insertadas=${insertados}, existentes=${existentes}, cedis=${cedisId}`);
  } catch (e) {
    console.error('seed/transportadora-extra error', e);
    res.status(500).send('No se pudo ejecutar el seed.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
