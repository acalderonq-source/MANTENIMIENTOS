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

// Salud simple (no toca DB) → evita 502
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Ver variables clave (no secretos)
app.get('/debug/env', (_req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL,
    TZ: process.env.TZ
  });
});

// Simular auth básica
app.use((req, res, next) => {
  if (!req.session.user) {
    req.session.user = { id: 1, username: 'admin', rol: 'ADMIN' };
  }
  res.locals.user = req.session.user;
  res.locals.dayjs = dayjs; // disponible en EJS
  next();
});

// ---------- Util: asegurar columna email en cedis ----------
async function ensureCedisEmailColumn() {
  const [cols] = await pool.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cedis' AND COLUMN_NAME = 'email'
  `);
  if (!Array.isArray(cols) || cols.length === 0) {
    console.warn('[DB] Agregando columna cedis.email ...');
    await pool.query(`ALTER TABLE cedis ADD COLUMN email VARCHAR(190) NULL DEFAULT NULL`);
  }
}

// ---------- Helpers calendario ----------
function esDomingo(iso) { return dayjs(iso).day() === 0; } // 0 = domingo
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

// Próximo sugerido para una unidad (45 días desde último evento -> evitando domingos/choques)
async function calcularProximoParaUnidad(unidadId) {
  const [hist] = await pool.query(
    `SELECT fecha_fin, fecha_inicio
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
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
     VALUES (?,?,?,?,?,?,1,?)`,
    [unidadId, u?.cedis_id || null, 'PREVENTIVO', 'Plan preventivo sugerido', prox, null, creadoPorUserId || null]
  );
  return prox;
}

// ---------- Email ----------
const smtp = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
};
const transport = (smtp.host ? nodemailer.createTransport(smtp) : null);
const FROM = process.env.SMTP_FROM || 'notificaciones@example.com';
const REPLY_TO = process.env.SMTP_REPLY_TO || FROM;

async function enviarRecordatorio({ email, cedis, placa, fecha }) {
  if (!transport) {
    console.warn('[MAIL] Transport no configurado. Saltando envío.');
    return;
  }
  const fechaNice = dayjs(fecha).format('YYYY-MM-DD');
  const html = `
    <p>Hola,</p>
    <p>Recordatorio de mantenimiento preventivo programado <b>en 3 días</b>.</p>
    <ul>
      <li><b>CEDIS:</b> ${cedis}</li>
      <li><b>Placa:</b> ${placa}</li>
      <li><b>Fecha programada:</b> ${fechaNice}</li>
    </ul>
    <p>Por favor, coordinar con el taller correspondiente.</p>
    <p>— Sistema de Mantenimientos</p>
  `;
  const text = `Recordatorio de mantenimiento en 3 días.
CEDIS: ${cedis}
Placa: ${placa}
Fecha programada: ${fechaNice}`;

  await transport.sendMail({
    from: FROM,
    to: email,
    replyTo: REPLY_TO,
    subject: `Recordatorio: mantenimiento ${placa} — ${fechaNice}`,
    text,
    html
  });
}

// ---------- CRON: enviar recordatorios 3 días antes ----------
function startCron() {
  // Corre a las 08:00 todos los días (TZ configurable con env TZ)
  cron.schedule('0 8 * * *', async () => {
    try {
      const [rows] = await pool.query(`
        SELECT m.id AS mant_id, m.fecha_inicio,
               u.placa,
               c.nombre AS cedis, c.email
          FROM mantenimientos m
          JOIN unidades u ON u.id=m.unidad_id
          LEFT JOIN cedis c ON c.id=m.cedis_id
         WHERE m.fecha_fin IS NULL
           AND DATE(m.fecha_inicio) = DATE(DATE_ADD(CURDATE(), INTERVAL 3 DAY))
           AND c.email IS NOT NULL
           AND c.email <> ''
      `);

      if (!rows.length) return;

      for (const r of rows) {
        try {
          await enviarRecordatorio({
            email: r.email,
            cedis: r.cedis || 'N/D',
            placa: r.placa,
            fecha: r.fecha_inicio
          });
        } catch (e) {
          console.error('[MAIL] Error enviando a', r.email, e.message);
        }
      }
      console.log(`[CRON] Recordatorios enviados: ${rows.length}`);
    } catch (e) {
      console.error('[CRON] Error buscando próximos recordatorios', e);
    }
  }, { timezone: process.env.TZ || 'UTC' });
}

// ---------- Home (con fallback si DB falla) ----------
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
    console.error('GET / fallback por error DB:', e.message);
    res.status(200).send(`
      <html><body style="font-family:system-ui">
        <h1>⚠️ Servicio arriba, pero DB no responde</h1>
        <p>La aplicación está corriendo, pero hubo un problema consultando la base de datos.</p>
        <pre>${e.message}</pre>
        <ul>
          <li><a href="/debug/env">/debug/env</a> — variables DB que está leyendo</li>
          <li><a href="/debug/dbping">/debug/dbping</a> — ping directo a la DB</li>
          <li><a href="/healthz">/healthz</a> — health simple</li>
        </ul>
      </body></html>
    `);
  }
});

// ========== Unidades (con filtro CEDIS + proximos) ==========
app.get('/unidades', async (req, res) => {
  const { cedis: cedisNombre, cedis_id } = req.query;

  const [cedisLista] = await pool.query(`SELECT id, nombre, email FROM cedis ORDER BY nombre`);

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
    [placa.toUpperCase(), (tipo || 'CAMION').toUpperCase(), cedis_id, 0, 'ACTIVA']
  );
  res.redirect('/unidades');
});

// Programar uno (ruta clásica)
app.post('/unidades/:id/programar', async (req, res) => {
  await programarPreventivo(Number(req.params.id), req.session.user?.id);
  res.redirect('/mantenimientos');
});

// ---------- Endpoint AI programar con diagnóstico ----------
app.post('/ai/programar', async (req, res) => {
  const creadoPor = req.session.user?.id || null;
  const body = req.body || {};
  const debug = String(process.env.DEBUG_AI || req.query.debug || '0') === '1';

  try {
    // Programar UNA unidad
    if (body.unidad_id) {
      const unidadId = Number(body.unidad_id);
      const [[u]] = await pool.query(`
        SELECT u.id, u.placa, u.cedis_id, c.email, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id=u.cedis_id
        WHERE u.id=? LIMIT 1`, [unidadId]);

      if (!u) return res.status(404).json({ ok:false, error:`Unidad ${unidadId} no existe` });
      if (!u.email) return res.status(400).json({ ok:false, error:`Falta correo del CEDIS ${u.cedis_nombre}. Cárgalo en /cedis` });

      const prox = await programarPreventivo(unidadId, creadoPor);
      return res.json({ ok:true, count:1, unidad_id:unidadId, fecha:prox });
    }

    // Validar correos de CEDIS
    const [missing] = await pool.query(`
      SELECT DISTINCT c.nombre
      FROM unidades u
      JOIN cedis c ON c.id=u.cedis_id
      WHERE u.estado='ACTIVA' AND (c.email IS NULL OR c.email='')
    `);
    if (missing.length) {
      return res.status(400).json({
        ok:false,
        error:`Faltan correos para CEDIS: ${missing.map(m=>m.nombre).join(', ')}. Cárgalos en /cedis`,
        code:'CEDIS_EMAILS_MISSING'
      });
    }

    const [unidadesActivas] = await pool.query(
      `SELECT id FROM unidades WHERE estado='ACTIVA' ORDER BY placa`
    );
    if (!unidadesActivas.length) {
      return res.status(400).json({ ok:false, error:'No hay unidades ACTIVAS para programar', code:'NO_ACTIVE_UNITS' });
    }

    let count = 0;
    const fechasAsignadasEnBatch = new Set();
    const fallos = [];

    for (const u of unidadesActivas) {
      try {
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
      } catch (e) {
        fallos.push({ unidad_id: u.id, error: e.message });
        if (debug) console.error('AI/programar fallo por unidad', u.id, e);
      }
    }

    return res.json({ ok:true, count, fallos, nota: 'Si hay fallos, revisa /debug/ai-preview' });
  } catch (e) {
    console.error('POST /ai/programar error', e);
    return res.status(500).json({ ok:false, error: e.message || 'Fallo no especificado', code:'UNHANDLED' });
  }
});

// ---------- Mantenimientos abiertos ----------
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

// ---------- Historial ----------
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

// ============ Exportar programados (Excel) =====================
app.get('/export/programados.xlsx', async (req, res) => {
  try {
    const { cedis: cedisNombre, cedis_id } = req.query;
    let where = `WHERE m.fecha_fin IS NULL AND m.fecha_inicio >= CURDATE()`;
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
        dayjs(r.fecha_inicio).format('YYYY-MM-DD'),
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

// ============ Seed: POST /seed/pegar (arreglo JSON) ===========
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
  if (n === 'HINOS' || s === 'HINOS') return 'HINO';
  if (n === 'GRANEL' || s === 'GRANEL' || s === 'GRANELES') return 'GRANEL';
  if (n === 'TECNICOS' || n === 'TECNICO') return 'TECNICO';
  if (n === 'TALLER') return 'TALLER';
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
app.post('/seed/pegar', async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ ok:false, error:'Manda un arreglo JSON en el body' });
    }
    let insertados = 0, existentes = 0, errores = 0;
    for (const raw of req.body) {
      try {
        const u = mapRawToUniform(raw);
        if (!u.placa) { errores++; continue; }
        const [ex] = await pool.query(`SELECT id FROM unidades WHERE placa=? LIMIT 1`, [u.placa]);
        if (Array.isArray(ex) && ex.length) { existentes++; continue; }
        const cedis_id = await ensureCedis(u.cedis);
        await pool.query(
          `INSERT INTO unidades (placa, tipo, cedis_id, kilometraje, estado)
           VALUES (?,?,?,?,?)`,
          [u.placa, u.tipo, cedis_id, 0, 'ACTIVA']
        );
        insertados++;
      } catch {
        errores++;
      }
    }
    res.json({ ok:true, insertados, existentes, errores, detallesMuestra: {} });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ============ Gestión de correo por CEDIS ======================
app.get('/cedis', async (_req, res) => {
  const [rows] = await pool.query(`SELECT id, nombre, COALESCE(email,'') AS email FROM cedis ORDER BY nombre`);
  res.json({ ok:true, cedis: rows });
});
app.post('/cedis/:id/email', async (req, res) => {
  const id = Number(req.params.id);
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok:false, error:'Email requerido' });
  await pool.query(`UPDATE cedis SET email=? WHERE id=?`, [email, id]);
  res.json({ ok:true, id, email });
});

// ============ Debug / Diagnóstico ==============================
app.get('/debug/dbping', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.get('/debug/unidades', async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, placa, tipo, cedis_id, estado FROM unidades ORDER BY id DESC LIMIT 25`);
    res.json({ total: rows.length, muestra: rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});
app.get('/debug/cedis', async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, nombre, COALESCE(email,'') AS email FROM cedis ORDER BY nombre`);
    res.json({ cedis: rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});
app.get('/debug/ai-preview', async (_req, res) => {
  try {
    const [missing] = await pool.query(`
      SELECT DISTINCT c.nombre
      FROM unidades u
      JOIN cedis c ON c.id=u.cedis_id
      WHERE u.estado='ACTIVA' AND (c.email IS NULL OR c.email='')
    `);

    const [unidades] = await pool.query(`
      SELECT u.id, u.placa, u.cedis_id, c.nombre AS cedis, COALESCE(c.email,'') AS email
      FROM unidades u
      LEFT JOIN cedis c ON c.id=u.cedis_id
      WHERE u.estado='ACTIVA'
      ORDER BY u.placa
    `);

    const results = [];
    const fechasAsignadas = new Set();

    for (const u of unidades) {
      try {
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
        while (fechasAsignadas.has(d.format('YYYY-MM-DD')) || d.day() === 0) d = d.add(1, 'day');
        finalDate = d.format('YYYY-MM-DD');
        results.push({ unidad_id: u.id, placa: u.placa, cedis: u.cedis, email: u.email, fecha: finalDate, ok:true });
        fechasAsignadas.add(finalDate);
      } catch (e) {
        results.push({ unidad_id: u.id, placa: u.placa, cedis: u.cedis, email: u.email, ok:false, error:e.message });
      }
    }

    res.json({
      ok:true,
      correos_faltantes: missing.map(m => m.nombre),
      total_unidades: unidades.length,
      simulacion: results
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    console.log('[DB] Detalle conexión:', {
      host: pool.config.connectionConfig.host,
      port: pool.config.connectionConfig.port,
      user: pool.config.connectionConfig.user,
      database: pool.config.connectionConfig.database,
      ssl: !!pool.config.connectionConfig.ssl
    });
    // Ping + asegurar columna email
    await pool.query('SELECT 1');
    await ensureCedisEmailColumn();
    console.log('[DB] Ping OK');
  } catch (e) {
    console.error('[DB] Ping FAILED:', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor escuchando en http://0.0.0.0:${PORT}`);
  });

  // Inicia cron de recordatorios
  startCron();
})();
