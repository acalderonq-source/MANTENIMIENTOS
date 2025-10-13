// src/server.js
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import methodOverride from 'method-override';
import expressLayouts from 'express-ejs-layouts';
import dayjs from 'dayjs';
import ExcelJS from 'exceljs';
import fs from 'fs';
import fsp from 'fs/promises';
import { pool } from './db.js';

import {
  aiClassify,
  aiSummarize,
  aiSuggestNext,
  aiPreventivePlan
} from './services/ai.js';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ========= Motor de vistas =========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/layout');

// ========= Middlewares base =========
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// estáticos (CSS / imágenes / JS del browser)
app.use(express.static(path.join(process.cwd(), 'public')));

// sesión simple
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false
}));

// usuario simulado + dayjs a las vistas
app.use((req, res, next) => {
  if (!req.session.user) {
    req.session.user = { id: 1, username: 'admin', rol: 'ADMIN' };
  }
  res.locals.user = req.session.user;
  res.locals.dayjs = dayjs;
  next();
});

// ========= Helpers mínimos =========
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
    if (d.day() === 0) d = d.add(1, 'day');
  }
}

async function calcularProximoParaUnidad(unidadId) {
  const [hist] = await pool.query(
    `SELECT fecha_fin, fecha_inicio
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
      LIMIT 1`, [unidadId]
  );
  const ultimo = hist?.[0] || null;
  let base = ultimo?.fecha_fin || ultimo?.fecha_inicio || dayjs().format('YYYY-MM-DD');
  let candidata = dayjs(base).add(45, 'day').format('YYYY-MM-DD');
  if (esDomingo(candidata)) candidata = siguienteNoDomingo(candidata);
  candidata = await fechaSinChoque(candidata);
  return candidata;
}

async function programarPreventivo(unidadId, creadoPorUserId) {
  const prox = await calcularProximoParaUnidad(unidadId);
  const [[u]] = await pool.query(`SELECT id, cedis_id FROM unidades WHERE id=?`, [unidadId]);
  await pool.query(
    `INSERT INTO mantenimientos
       (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
     VALUES (?,?,?,?,?,?,1,?)`,
    [unidadId, u?.cedis_id || null, 'PREVENTIVO', 'Plan preventivo sugerido', prox, null, creadoPorUserId || null]
  );
  return prox;
}

// ========= Rutas UI =========
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

app.get('/unidades', async (req, res) => {
  const { cedis: cedisNombre, cedis_id } = req.query;
  const [cedisLista] = await pool.query(`SELECT id, nombre FROM cedis ORDER BY nombre`);

  let where = '';
  const params = [];
  if (cedis_id) { where = 'WHERE u.cedis_id = ?'; params.push(Number(cedis_id)); }
  else if (cedisNombre) { where = 'WHERE c.nombre = ?'; params.push(cedisNombre); }

  const [unidades] = await pool.query(
    `SELECT u.id, u.placa, u.tipo, u.kilometraje, u.estado, c.nombre AS cedis_nombre
       FROM unidades u
       LEFT JOIN cedis c ON c.id=u.cedis_id
       ${where}
      ORDER BY u.placa`, params);

  const proximos = {};
  for (const u of unidades) {
    try { proximos[u.id] = await calcularProximoParaUnidad(u.id); }
    catch { proximos[u.id] = null; }
  }

  res.render('unidades', {
    title: 'Unidades',
    unidades,
    cedisLista,
    filtroActual: { cedisNombre: cedisNombre || '', cedisId: cedis_id || '' },
    proximos
  });
});

// Programar uno
app.post('/unidades/:id/programar', async (req, res) => {
  await programarPreventivo(Number(req.params.id), req.session.user?.id);
  res.redirect('/mantenimientos');
});

// API para programar uno o todos (batch)
app.post('/ai/programar', async (req, res) => {
  try {
    const creadoPor = req.session.user?.id || null;
    const body = req.body || {};

    if (body.unidad_id) {
      const unidadId = Number(body.unidad_id);
      const prox = await programarPreventivo(unidadId, creadoPor);
      return res.json({ ok: true, count: 1, unidad_id: unidadId, fecha: prox });
    }

    const [unidadesActivas] = await pool.query(`SELECT id FROM unidades WHERE estado='ACTIVA' ORDER BY placa`);
    let count = 0;
    const fechasAsignadasEnBatch = new Set();

    for (const u of unidadesActivas) {
      const [hist] = await pool.query(
        `SELECT fecha_fin, fecha_inicio FROM mantenimientos WHERE unidad_id=? ORDER BY id DESC LIMIT 1`, [u.id]
      );
      const ultimo = hist?.[0] || null;
      let base = ultimo?.fecha_fin || ultimo?.fecha_inicio || dayjs().format('YYYY-MM-DD');
      let candidata = dayjs(base).add(45, 'day').format('YYYY-MM-DD');
      if (esDomingo(candidata)) candidata = siguienteNoDomingo(candidata);
      candidata = await fechaSinChoque(candidata);

      let d = dayjs(candidata);
      while (fechasAsignadasEnBatch.has(d.format('YYYY-MM-DD')) || d.day() === 0) d = d.add(1, 'day');
      const finalDate = d.format('YYYY-MM-DD');
      fechasAsignadasEnBatch.add(finalDate);

      const [[ur]] = await pool.query(`SELECT id, cedis_id FROM unidades WHERE id=?`, [u.id]);
      await pool.query(
        `INSERT INTO mantenimientos
           (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?,?,?,?,?,1,?)`,
        [u.id, ur?.cedis_id || null, 'PREVENTIVO', 'Plan preventivo sugerido', finalDate, null, creadoPor]
      );
      count++;
    }

    res.json({ ok: true, count });
  } catch (e) {
    console.error('POST /ai/programar error', e);
    res.status(500).json({ ok: false, error: 'No se pudo programar por IA.' });
  }
});

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

// ========= IA endpoints =========
app.post('/ai/clasificar', async (req, res) => {
  try {
    const { motivo, placa, km, cedis } = req.body || {};
    const out = await aiClassify({ motivo, placa, km, cedis });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('POST /ai/clasificar', e);
    res.status(500).json({ ok: false, error: 'IA clasificar falló' });
  }
});

app.get('/ai/resumen/:id', async (req, res) => {
  try {
    const out = await aiSummarize({ pool, mantId: Number(req.params.id) });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('GET /ai/resumen', e);
    res.status(500).json({ ok: false, error: 'IA resumen falló' });
  }
});

app.get('/ai/siguiente/:placa', async (req, res) => {
  try {
    const out = await aiSuggestNext({ pool, placa: req.params.placa.toUpperCase() });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('GET /ai/siguiente', e);
    res.status(500).json({ ok: false, error: 'IA sugerir falló' });
  }
});

app.get('/ai/plan/:unidadId', async (req, res) => {
  try {
    const out = await aiPreventivePlan({ pool, unidadId: Number(req.params.unidadId) });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('GET /ai/plan', e);
    res.status(500).json({ ok: false, error: 'IA plan falló' });
  }
});

// ========= Debug útil =========
app.get('/debug/env', (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '(set)' : '(missing)'
  });
});

app.get('/debug/dbping', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: r?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ========= Arranque =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor en http://localhost:${PORT}`);
});
