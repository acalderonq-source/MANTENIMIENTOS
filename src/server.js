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
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { pool } from './db.js';

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

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false
}));

// Simular auth básica
app.use((req, res, next) => {
  if (!req.session.user) {
    req.session.user = { id: 1, username: 'admin', rol: 'ADMIN' };
  }
  res.locals.user = req.session.user;
  res.locals.dayjs = dayjs;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

// ---------- Mailer ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true', // true = 465
  auth: (process.env.SMTP_USER || process.env.SMTP_PASS) ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});
const MAIL_FROM = process.env.SMTP_FROM || 'notificaciones@example.com';
const MAIL_REPLY_TO = process.env.SMTP_REPLY_TO || MAIL_FROM;

async function sendMail({ to, subject, html }) {
  if (!to) throw new Error('Sin destinatario');
  await transporter.sendMail({ from: MAIL_FROM, to, replyTo: MAIL_REPLY_TO, subject, html });
}

// ---------- Helpers calendario ----------
function esDomingo(iso) { return dayjs(iso).day() === 0; }
function siguienteNoDomingo(iso) {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d.format('YYYY-MM-DD');
}
async function fechaSinChoque(fechaBase, excluirPlaca = null) {
  let d = dayjs(fechaBase);
  for (let i = 0; i < 365; i++) {
    if (d.day() === 0) { d = d.add(1, 'day'); continue; }
    const fecha = d.format('YYYY-MM-DD');
    const [rows] = await pool.query(
      `SELECT u.placa
         FROM mantenimientos m
         JOIN unidades u ON u.id=m.unidad_id
        WHERE m.fecha_fin IS NULL
          AND DATE(m.fecha_inicio) = DATE(?)`,
      [fecha]
    );
    const hayChoque = rows.length > 0 && rows.some(r => r.placa !== excluirPlaca);
    if (!hayChoque) return fecha;
    d = d.add(1, 'day');
  }
  throw new Error('No se encontró fecha disponible');
}

// Próximo sugerido para una unidad (45 días desde último evento)
async function calcularProximoParaUnidad(unidadId) {
  const [hist] = await pool.query(
    `SELECT fecha_fin, fecha_inicio
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY COALESCE(fecha_fin, fecha_inicio) DESC, id DESC
      LIMIT 1`, [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;
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
     VALUES (?,?,?,?,?,?,0,?)`,
    [unidadId, u?.cedis_id || null, 'PREVENTIVO', 'Plan preventivo sugerido', prox, null, creadoPorUserId || null]
  );
  return prox;
}

// ---------- Home ----------
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

// ========== Unidades (con filtro CEDIS + proximos) ==========
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
      ORDER BY u.placa`,
    params
  );

  const proximosArr = await Promise.all(
    unidades.map(u => calcularProximoParaUnidad(u.id).catch(() => null))
  );
  const proximos = {};
  unidades.forEach((u, i) => { proximos[u.id] = proximosArr[i]; });

  res.render('unidades', {
    title: 'Unidades',
    unidades,
    cedisLista,
    filtroActual: { cedisNombre: cedisNombre || '', cedisId: cedis_id || '' },
    proximos
  });
});

// Crear unidad (simple)
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
    [String(placa || '').toUpperCase(), (tipo || 'CAMION').toUpperCase(), cedis_id, 0, 'ACTIVA']
  );
  res.redirect('/unidades');
});

// Programar uno (verifica correo del CEDIS)
app.post('/unidades/:id/programar', async (req, res) => {
  const unidadId = Number(req.params.id);
  const [[u]] = await pool.query(`
    SELECT u.id, u.cedis_id, c.email, c.nombre AS cedis_nombre
    FROM unidades u
    LEFT JOIN cedis c ON c.id=u.cedis_id
    WHERE u.id=? LIMIT 1`, [unidadId]);

  if (!u) return res.status(404).send('Unidad no existe');
  if (!u.email) {
    req.session.flash = { error: `Falta correo del CEDIS ${u.cedis_nombre}. Cárgalo en /cedis.` };
    return res.redirect('/cedis');
  }
  await programarPreventivo(unidadId, req.session.user?.id);
  res.redirect('/mantenimientos');
});

// Endpoint AI programar (uno o todos) con validación de correos
app.post('/ai/programar', async (req, res) => {
  try {
    const creadoPor = req.session.user?.id || null;
    const body = req.body || {};

    if (body.unidad_id) {
      const unidadId = Number(body.unidad_id);
      const [[u]] = await pool.query(`
        SELECT u.id, u.cedis_id, c.email, c.nombre AS cedis_nombre
        FROM unidades u LEFT JOIN cedis c ON c.id=u.cedis_id WHERE u.id=? LIMIT 1`, [unidadId]);
      if (!u?.email) {
        return res.status(400).json({ ok:false, error:`Falta correo del CEDIS ${u?.cedis_nombre || ''}. Cárgalo en /cedis` });
      }
      const prox = await programarPreventivo(unidadId, creadoPor);
      return res.json({ ok: true, count: 1, unidad_id: unidadId, fecha: prox });
    }

    const [missing] = await pool.query(`
      SELECT DISTINCT c.nombre
      FROM unidades u
      JOIN cedis c ON c.id=u.cedis_id
      WHERE u.estado='ACTIVA' AND (c.email IS NULL OR c.email='')
    `);
    if (missing.length) {
      return res.status(400).json({
        ok:false,
        error:`Faltan correos para CEDIS: ${missing.map(m=>m.nombre).join(', ')}. Cárgalos en /cedis`
      });
    }

    const [unidadesActivas] = await pool.query(`SELECT id FROM unidades WHERE estado='ACTIVA' ORDER BY placa`);
    let count = 0;
    const fechasAsignadasEnBatch = new Set();

    for (const u of unidadesActivas) {
      const [hist] = await pool.query(
        `SELECT fecha_fin, fecha_inicio
           FROM mantenimientos
          WHERE unidad_id=?
          ORDER BY COALESCE(fecha_fin, fecha_inicio) DESC, id DESC
          LIMIT 1`, [u.id]
      );
      const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;
      const base = ultimo?.fecha_fin || ultimo?.fecha_inicio || dayjs().format('YYYY-MM-DD');

      let candidata = dayjs(base).add(45, 'day');
      if (candidata.day() === 0) candidata = candidata.add(1, 'day');

      let finalDate = await fechaSinChoque(candidata.format('YYYY-MM-DD'));

      let d = dayjs(finalDate);
      while (fechasAsignadasEnBatch.has(d.format('YYYY-MM-DD')) || d.day() === 0) d = d.add(1, 'day');
      finalDate = d.format('YYYY-MM-DD');
      fechasAsignadasEnBatch.add(finalDate);

      const [[ur]] = await pool.query(`SELECT id, cedis_id FROM unidades WHERE id=?`, [u.id]);
      await pool.query(
        `INSERT INTO mantenimientos
           (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?,?,?,?,?,0,?)`,
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

// ---- Admin: emails por CEDIS ----
app.get('/cedis', async (_req, res) => {
  const [rows] = await pool.query(`SELECT id, nombre, COALESCE(email,'') AS email FROM cedis ORDER BY nombre`);
  res.render('cedis_emails', { title: 'Correos por CEDIS', items: rows });
});
app.post('/cedis/:id/email', async (req, res) => {
  const id = Number(req.params.id);
  const email = (req.body?.email || '').trim() || null;
  await pool.query(`UPDATE cedis SET email=? WHERE id=?`, [email, id]);
  req.session.flash = { ok: 'Correo guardado.' };
  res.redirect('/cedis');
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
  const placa = String(req.params.placa || '').toUpperCase();
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

// ============ Exportar programados (Excel) =====================
app.get('/export/programados.xlsx', async (req, res) => {
  try {
    const { cedis: cedisNombre, cedis_id } = req.query;
    let where = `WHERE m.fecha_fin IS NULL AND DATE(m.fecha_inicio) >= CURDATE()`;
    const params = [];
    if (cedis_id) { where += ` AND m.cedis_id = ?`; params.push(Number(cedis_id)); }
    else if (cedisNombre) { where += ` AND c.nombre = ?`; params.push(cedisNombre); }

    const [rows] = await pool.query(
      `SELECT 
         m.id, u.placa, c.nombre AS cedis, m.tipo, m.motivo, m.fecha_inicio,
         m.km_al_entrar, m.reservado_inventario, m.creado_por
       FROM mantenimientos m
       JOIN unidades u ON u.id = m.unidad_id
       LEFT JOIN cedis c ON c.id = m.cedis_id
       ${where}
       ORDER BY m.fecha_inicio ASC, u.placa ASC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Programados');

    ws.mergeCells('A1', 'H1'); ws.getCell('A1').value = 'Mantenimientos Programados';
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell('A1').font = { bold: true, size: 16 }; ws.getRow(1).height = 26;

    ws.mergeCells('A2', 'H2'); ws.getCell('A2').value = `Generado: ${dayjs().format('YYYY-MM-DD HH:mm')}`;
    ws.getCell('A2').alignment = { horizontal: 'center' }; ws.getCell('A2').font = { italic: true, size: 11 };

    const headers = ['ID', 'Placa', 'CEDIS', 'Tipo', 'Motivo/Notas', 'Fecha Programada', 'KM al entrar', 'Reservado Inv.'];
    ws.addRow([]); ws.addRow(headers);

    const headerRow = ws.getRow(4);
    headerRow.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003B73' } };
      c.border = { top:{style:'thin',color:{argb:'FF1F4E78'}}, left:{style:'thin',color:{argb:'FF1F4E78'}},
                   bottom:{style:'thin',color:{argb:'FF1F4E78'}}, right:{style:'thin',color:{argb:'FF1F4E78'}} };
    });

    for (const r of rows) {
      ws.addRow([
        r.id, r.placa, r.cedis || 'N/D', r.tipo || 'N/D', r.motivo || 'N/D',
        (r.fecha_inicio && dayjs(r.fecha_inicio).isValid()) ? dayjs(r.fecha_inicio).format('YYYY-MM-DD') : '',
        r.km_al_entrar ?? '', r.reservado_inventario ? 'Sí' : 'No'
      ]);
    }

    for (let i = 5; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      row.alignment = { vertical: 'middle' }; row.height = 20;
      row.eachCell(c => c.border = { top:{style:'thin',color:{argb:'FFBFBFBF'}}, left:{style:'thin',color:{argb:'FFBFBFBF'}},
                                     bottom:{style:'thin',color:{argb:'FFBFBFBF'}}, right:{style:'thin',color:{argb:'FFBFBFBF'}} });
      if (i % 2 === 1) row.eachCell(c => c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F7FB' } });
    }

    [8,12,22,14,50,16,16,16].forEach((w, idx) => ws.getColumn(idx + 1).width = w);
    ws.getColumn(5).alignment = { wrapText: true, vertical: 'middle' };
    ws.getColumn(6).alignment = { horizontal: 'center' };
    ws.autoFilter = { from: { row:4, column:1 }, to: { row:4, column: headers.length } };

    ws.addRow([]);
    const infoRow = ws.addRow([`Total programados: ${rows.length}`]);
    ws.mergeCells(`A${infoRow.number}:H${infoRow.number}`);
    infoRow.getCell(1).font = { bold: true }; infoRow.getCell(1).alignment = { horizontal: 'right' };

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="programados_${dayjs().format('YYYYMMDD_HHmm')}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  } catch (e) {
    console.error('export/programados.xlsx error', e);
    res.status(500).send('No se pudo generar la planilla.');
  }
});

// ============ Normalizadores / helpers de seed =================
function normCedisName(x) {
  if (!x) return null;
  const t = String(x).trim();
  const title = t.toLowerCase().split(' ').map(s => s ? s[0].toUpperCase() + s.slice(1) : s).join(' ');
  if (/^transportadora$/i.test(t)) return 'TRANSPORTADORA';
  return title;
}
function normPlaca(rawId, rawPlaca) {
  let p = (rawPlaca || rawId || '').toString().trim().toUpperCase();
  p = p.replace(/\s+/g, '').replace(/^([A-Z]+)-(\d+)$/, '$1$2');
  if (/^\d+$/.test(p)) p = 'C' + p;
  return p;
}
function inferTipo({ tipo, negocio, segmento }) {
  const t = (tipo || '').toString().trim().toUpperCase();
  if (t) return t;
  const n = (negocio || '').toString().trim().toUpperCase();
  const s = (segmento || '').toString().trim().toUpperCase();
  if (['CABEZAL','CISTERNA','TANDEM','CARRETA'].includes(s)) return s;
  if (n === 'HINOS') return 'HINO';
  if (n === 'GRANEL') return 'GRANEL';
  if (n === 'TECNICOS' || n === 'TECNICO') return 'TECNICO';
  if (n === 'TALLER') return 'TALLER';
  if (s === 'HINOS') return 'HINO';
  if (s === 'GRANEL' || s === 'GRANELES') return 'GRANEL';
  if (s === 'OTROS') return 'OTROS';
  return 'CAMION';
}
async function ensureCedis(nombre) {
  const n = normCedisName(nombre);
  if (!n) return null;
  await pool.query(`INSERT IGNORE INTO cedis (nombre) VALUES (?)`, [n]);
  const [[row]] = await pool.query(`SELECT id FROM cedis WHERE nombre=? LIMIT 1`, [n]);
  return row?.id || null;
}
function mapRawToUniform(raw) {
  const placa = normPlaca(raw.id, raw.placa);
  const cedis = raw.cedis ?? raw.CEDIS ?? null;
  const tipo = inferTipo(raw);
  return { placa, cedis, tipo };
}

// ============ SEED: Cargar TODOS los .json de /data ======================
app.get('/seed/cargar-archivos', async (req, res) => {
  try {
    const DATA_DIR = path.resolve(__dirname, '../data');
    console.log('[seed] DATA_DIR =', DATA_DIR);

    if (!fs.existsSync(DATA_DIR)) {
      return res.status(400).json({ ok:false, error:`No existe ${DATA_DIR}` });
    }

    const names = await fsp.readdir(DATA_DIR);
    const jsonFiles = names.filter(n => n.toLowerCase().endsWith('.json'));
    console.log('[seed] JSON files encontrados:', jsonFiles);

    const all = [];
    for (const fname of jsonFiles) {
      try {
        const full = path.join(DATA_DIR, fname);
        const buf = await fsp.readFile(full, 'utf8');
        const arr = JSON.parse(buf);
        if (Array.isArray(arr) && arr.length) all.push(...arr);
      } catch (e) {
        console.warn(`[seed] No se pudo leer ${fname}:`, e.message);
      }
    }

    let insertados = 0, existentes = 0, errores = 0;
    const detalles = [];

    for (const raw of all) {
      try {
        const u = mapRawToUniform(raw);
        if (!u.placa) { errores++; detalles.push({ placa:null, error:'Sin placa/id' }); continue; }

        const [ex] = await pool.query(`SELECT id FROM unidades WHERE placa=? LIMIT 1`, [u.placa]);
        if (Array.isArray(ex) && ex.length) { existentes++; continue; }

        const cedis_id = await ensureCedis(u.cedis);
        await pool.query(
          `INSERT INTO unidades (placa, tipo, cedis_id, kilometraje, estado)
           VALUES (?,?,?,?,?)`,
          [u.placa, u.tipo, cedis_id, 0, 'ACTIVA']
        );
        insertados++;
      } catch (e) {
        errores++; detalles.push({ placa: raw?.placa || raw?.id || null, error: e.message });
      }
    }

    res.json({ ok:true, totalLeidos: all.length, insertados, existentes, errores, detallesMuestra: detalles.slice(0,10), archivos: jsonFiles });
  } catch (e) {
    console.error('seed/cargar-archivos error', e);
    res.status(500).json({ ok:false, error:'Fallo al cargar desde archivos.' });
  }
});

// Seed directo pegando el arreglo en el body (JSON)
app.post('/seed/pegar', async (req, res) => {
  try {
    const arr = req.body;
    if (!Array.isArray(arr)) {
      return res.status(400).json({ ok:false, error:'Manda un arreglo JSON en el body' });
    }

    let insertados = 0, existentes = 0, errores = 0;
    const detalles = [];

    for (const raw of arr) {
      try {
        const u = mapRawToUniform(raw);
        if (!u.placa) { errores++; detalles.push({ placa:null, error:'Sin placa/id' }); continue; }

        const [ex] = await pool.query(`SELECT id FROM unidades WHERE placa=? LIMIT 1`, [u.placa]);
        if (Array.isArray(ex) && ex.length) { existentes++; continue; }

        const cedis_id = await ensureCedis(u.cedis);
        await pool.query(
          `INSERT INTO unidades (placa, tipo, cedis_id, kilometraje, estado)
           VALUES (?,?,?,?,?)`,
          [u.placa, u.tipo, cedis_id, 0, 'ACTIVA']
        );
        insertados++;
      } catch (e) {
        errores++; detalles.push({ placa: raw?.placa || raw?.id || null, error: e.message });
      }
    }

    res.json({ ok:true, insertados, existentes, errores, detallesMuestra: detalles.slice(0,10) });
  } catch (e) {
    console.error('POST /seed/pegar error', e);
    res.status(500).json({ ok:false, error:'Fallo seed pegado.' });
  }
});

// Debug: ver qué hay realmente en la DB
app.get('/debug/unidades', async (_req, res) => {
  const [[c]] = await pool.query(`SELECT COUNT(*) AS total FROM unidades`);
  const [rows] = await pool.query(`SELECT id, placa, tipo, cedis_id, estado FROM unidades ORDER BY id DESC LIMIT 50`);
  res.json({ total: c.total, muestra: rows });
});
app.get('/debug/cedis', async (_req, res) => {
  const [rows] = await pool.query(`SELECT id, nombre, email FROM cedis ORDER BY nombre`);
  res.json({ cedis: rows });
});

// ---------- Recordatorios 3 días antes ----------
function mailTemplate({ cedis, fecha, placas }) {
  const list = placas.map(p => `<li><strong>${p}</strong></li>`).join('');
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.45">
      <h2>Recordatorio de Mantenimiento Preventivo</h2>
      <p><b>CEDIS:</b> ${cedis}</p>
      <p><b>Fecha programada:</b> ${fecha}</p>
      <p><b>Unidades:</b></p>
      <ul>${list}</ul>
      <p style="color:#555">Este correo se genera automáticamente 3 días antes de la fecha programada.</p>
    </div>`;
}

async function sendRemindersForDate(targetISO) {
  const [rows] = await pool.query(`
    SELECT DATE(m.fecha_inicio) AS fecha, u.placa, c.nombre AS cedis, c.email
    FROM mantenimientos m
    JOIN unidades u ON u.id = m.unidad_id
    LEFT JOIN cedis c ON c.id = m.cedis_id
    WHERE m.fecha_fin IS NULL
      AND DATE(m.fecha_inicio) = ?
      AND c.email IS NOT NULL AND c.email <> ''
    ORDER BY c.nombre, u.placa
  `, [targetISO]);

  if (!rows.length) return { sent: 0 };

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.cedis}||${r.fecha}||${r.email}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.placa);
  }

  let sent = 0;
  for (const [key, placas] of groups.entries()) {
    const [cedis, fecha, email] = key.split('||');
    const html = mailTemplate({ cedis, fecha, placas });
    await sendMail({
      to: email,
      subject: `Recordatorio: mantenimiento ${fecha} — ${cedis}`,
      html
    });
    sent++;
  }
  return { sent };
}

// CRON diario 08:00 (TZ configurable)
cron.schedule('0 8 * * *', async () => {
  try {
    const target = dayjs().add(3, 'day').format('YYYY-MM-DD');
    const res = await sendRemindersForDate(target);
    console.log(`[CRON] Reminders for ${target}:`, res);
  } catch (e) {
    console.error('[CRON] reminder error', e);
  }
}, { timezone: process.env.TZ || 'UTC' });

// Endpoint manual de prueba
app.get('/debug/remind', async (req, res) => {
  const d = (req.query.date || dayjs().add(3, 'day').format('YYYY-MM-DD'));
  try {
    const out = await sendRemindersForDate(d);
    res.json({ ok:true, date:d, ...out });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor escuchando en http://0.0.0.0:${PORT}`);
});
