// src/server.js
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import methodOverride from 'method-override';
import expressLayouts from 'express-ejs-layouts';
import dayjs from 'dayjs';

// ===== DB (MEMORY por defecto) =====
import { pool } from './db.js';


// ===== IA (tus servicios con GPT-5) =====
import { aiClassify, aiSuggestNext, aiSummarize, aiPreventivePlan } from './services/ai.js';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== Vistas / middlewares =====
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

// Helpers a las vistas
app.use((req, res, next) => {
  // Usuario “fake” para desarrollo. Si activas login real, cámbialo.
  res.locals.user  = req.session.user || { id: 1, username: 'admin', rol: 'ADMIN' };
  res.locals.dayjs = dayjs;
  next();
});

function requireAuth(req, res, next) { return next(); }

// ===== Utilidades de fecha =====
function avoidSunday(s) {
  const d = dayjs(s).startOf('day');
  return d.day() === 0 ? d.add(1, 'day').format('YYYY-MM-DD') : d.format('YYYY-MM-DD');
}
function atLeastTomorrow(s) {
  const d = dayjs(s).startOf('day');
  const t = dayjs().startOf('day');
  return d.isAfter(t) ? d.format('YYYY-MM-DD') : t.add(1, 'day').format('YYYY-MM-DD');
}

// ---- Catálogo base de trabajos preventivos (se suma a lo que diga la IA)
const TASK_CATALOG = [
  // Motor
  'Cambio de aceite', 'Cambio de filtro de aceite', 'Cambio de filtro de aire',
  'Cambio de filtro de combustible', 'Revisión de correas', 'Limpieza de inyectores',
  // Fluidos
  'Revisión de niveles (aceite, refrigerante, frenos, dirección)', 'Purgado de frenos',
  'Cambio de refrigerante', 'Cambio de líquido de frenos',
  // Frenos y suspensión
  'Revisión de balatas/zapatas', 'Ajuste de frenos', 'Revisión de discos/campanas',
  'Revisión de amortiguadores', 'Revisión de bujes y rótulas',
  // Transmisión / Tracción
  'Cambio de aceite de transmisión', 'Revisión de embrague', 'Revisión de semiejes',
  'Engrase de crucetas',
  // Sistema eléctrico
  'Revisión de batería', 'Revisión de alternador', 'Inspección de cableado',
  'Revisión de luces (alta/baja/stop/posición)',
  // Llantas
  'Rotación de llantas', 'Alineación y balanceo', 'Revisión de presión',
  // Seguridad
  'Revisión de extintor', 'Revisión de botiquín', 'Revisión de triángulos',
  'Calibración de tacógrafo (si aplica)',
  // Carrocería / Cabina
  'Lubricación de bisagras', 'Revisión de cierres', 'Inspección de fugas',
  // Semirremolque (S)
  'Revisión de kingpin', 'Revisión de patines', 'Revisión de rampas y seguros'
];

// ===== Espaciado mínimo de 7 días ENTRE PLACAS (consulta BD: robusto a concurrencia) =====
async function getScheduledDatesFromDB() {
  const [rows] = await pool.query(`
    SELECT fecha_inicio
      FROM mantenimientos
     WHERE fecha_fin IS NULL
       AND fecha_inicio IS NOT NULL
  `);
  const today = dayjs().startOf('day');
  return (rows || [])
    .map(r => dayjs(r.fecha_inicio).startOf('day'))
    .filter(d => d.isSame(today, 'day') || d.isAfter(today));
}
async function violatesSpacingDB(candidateDayjs, spacingDays = 7) {
  const scheduled = await getScheduledDatesFromDB();
  for (const d of scheduled) {
    const diff = Math.abs(candidateDayjs.diff(d, 'day'));
    if (diff < spacingDays) return true;
  }
  return false;
}
async function findNextSpacedDateDB(candidate, spacingDays = 7) {
  let d = dayjs(candidate).startOf('day');
  const today = dayjs().startOf('day');
  while (true) {
    if (!d.isAfter(today)) d = today.add(1, 'day'); // nunca hoy
    if (d.day() === 0) d = d.add(1, 'day');         // sin domingo
    const choca = await violatesSpacingDB(d, spacingDays);
    if (!choca) return d.format('YYYY-MM-DD');
    d = d.add(1, 'day'); // prueba el siguiente día
  }
}

// ================================================================
//                         RUTAS
// ================================================================

// Dashboard (KPIs + últimos 10)
app.get('/', requireAuth, async (req, res) => {
  const [[kpis]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM unidades) as unidades,
      (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) as en_taller,
      (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) as hoy
  `);
  const [mants] = await pool.query(`
    SELECT m.id, u.placa, c.nombre as cedis, m.tipo, m.fecha_inicio, m.fecha_fin, m.duracion_dias
    FROM mantenimientos m
    JOIN unidades u ON u.id=m.unidad_id
    LEFT JOIN cedis c ON c.id=m.cedis_id
    ORDER BY m.id DESC LIMIT 10
  `);
  res.render('dashboard', { title: 'Dashboard', kpis, mants });
});

// Unidades (próximo IA + programar)
app.get('/unidades', requireAuth, async (req, res) => {
  const [unidadesRows] = await pool.query(`
    SELECT u.*, c.nombre AS cedis_nombre
      FROM unidades u
      LEFT JOIN cedis c ON c.id=u.cedis_id
     ORDER BY u.id DESC
  `);
  const [mants] = await pool.query(`
    SELECT m.*, u.placa, u.id AS unidad_id, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id = m.unidad_id
      LEFT JOIN cedis c ON c.id = m.cedis_id
  `);
  const today = dayjs().format('YYYY-MM-DD');
  const proximos = {};
  (mants || []).forEach(m => {
    if (!m.fecha_fin && m.fecha_inicio && m.fecha_inicio >= today) {
      const cur = proximos[m.unidad_id];
      if (!cur || m.fecha_inicio < cur) proximos[m.unidad_id] = m.fecha_inicio;
    }
  });
  res.render('unidades', { title: 'Unidades', unidades: unidadesRows, cedis: [], proximos });
});

// Mantenimientos — SOLO abiertos/programados
app.get('/mantenimientos', requireAuth, async (req, res) => {
  const [allRows] = await pool.query(`
    SELECT m.*, u.placa, u.id AS unidad_id, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
      LEFT JOIN cedis c ON c.id=m.cedis_id
      ORDER BY m.id DESC
  `);
  const rows = (allRows || [])
    .filter(m => !m.fecha_fin)
    .sort((a, b) => {
      const aKey = (a.fecha_inicio || '9999-12-31') + String(1e9 - a.id).padStart(10, '0');
      const bKey = (b.fecha_inicio || '9999-12-31') + String(1e9 - b.id).padStart(10, '0');
      return aKey.localeCompare(bKey);
    });
  res.render('mantenimientos_list', { title: 'Mantenimientos', mants: rows });
});

// Historial — SOLO cerrados
app.get('/historial', requireAuth, async (req, res) => {
  const [allRows] = await pool.query(`
    SELECT m.*, u.placa, u.id AS unidad_id, c.nombre AS cedis_nombre
      FROM mantenimientos m
      JOIN unidades u ON u.id=m.unidad_id
      LEFT JOIN cedis c ON c.id=m.cedis_id
      ORDER BY m.id DESC
  `);
  const rows = (allRows || []).filter(m => !!m.fecha_fin);
  res.render('historial', { title: 'Historial', mants: rows });
});

// === Previsualizar plan IA para un mantenimiento (antes de cerrar)
app.get('/ai/plan/:mantId', requireAuth, async (req, res) => {
  try {
    const mantId = Number(req.params.mantId);
    const [[m]] = await pool.query(`SELECT unidad_id FROM mantenimientos WHERE id=?`, [mantId]);
    if (!m) return res.status(404).json({ error: 'Mantenimiento no encontrado' });

    const plan = await aiPreventivePlan({ pool, unidadId: m.unidad_id });
    const candidata = atLeastTomorrow(avoidSunday(plan.fecha_sugerida));
    const fecha = await findNextSpacedDateDB(candidata, 7);

    // Unir IA + catálogo (únicos)
    const iaTareas = Array.isArray(plan.tareas) ? plan.tareas : [];
    const set = new Set([...iaTareas, ...TASK_CATALOG]);
    const tareasUnificadas = Array.from(set);

    return res.json({
      ok: true,
      fecha_sugerida: fecha,
      motivo_sugerido: plan.motivo_sugerido || 'Plan preventivo sugerido',
      tareas: tareasUnificadas
    });
  } catch (e) {
    console.error('ai/plan error', e);
    res.status(500).json({ ok: false, error: 'No se pudo generar el plan.' });
  }
});

// Cerrar “Se realizó” (+ trabajos y nota) + reprogramar por IA (7 días entre placas)
app.post('/mantenimientos/:id/realizado', requireAuth, async (req, res) => {
  const id  = Number(req.params.id);
  const hoy = dayjs().format('YYYY-MM-DD');
  console.log('[CERRAR] Recibido id=', id);

  // 0) Guardar trabajos/nota en el motivo del cerrado (bitácora simple)
  try {
    const hechos = Array.isArray(req.body?.hechos) ? req.body.hechos : [];
    const nota   = (req.body?.nota || '').trim();
    if (hechos.length || nota) {
      const texto = [
        'Cierre:',
        hechos.length ? ('• Trabajos: ' + hechos.join(', ')) : null,
        nota ? ('• Nota: ' + nota) : null
      ].filter(Boolean).join('  |  ');
      await pool.query(
        `UPDATE mantenimientos SET motivo = CONCAT(COALESCE(motivo,''), '  ||  ', ?) WHERE id=?`,
        [texto, id]
      );
    }
  } catch (_) { /* si el driver no soporta CONCAT, ignoramos */ }

  // 1) Cerrar actual
  await pool.query(
    `UPDATE mantenimientos
        SET fecha_fin=?, duracion_dias = DATEDIFF(?, fecha_inicio), reservado_inventario=0
      WHERE id=?`,
    [hoy, hoy, id]
  );
  console.log('[CERRAR] Actualizado fecha_fin=', hoy);

  // 2) Unidad
  const [[rowU]] = await pool.query(`SELECT unidad_id FROM mantenimientos WHERE id=?`, [id]);
  const unidadId = rowU?.unidad_id;
  console.log('[CERRAR] unidadId=', unidadId);

  // 3) Reprogramación automática (preventivo) con separación de 7 días
  if (unidadId) {
    const plan      = await aiPreventivePlan({ pool, unidadId });
    const candidata = atLeastTomorrow(avoidSunday(plan.fecha_sugerida));
    const fecha     = await findNextSpacedDateDB(candidata, 7);
    const userId    = (req.session.user?.id || 1);

    const trabajosMarcados = Array.isArray(req.body?.hechos) ? req.body.hechos : [];
    const labelHechos = trabajosMarcados.length ? ` / Hechos: ${trabajosMarcados.join(', ')}` : '';
    const motivo = (plan.motivo_sugerido || 'Plan preventivo sugerido') + labelHechos;

    console.log('[REPROGRAMAR] fecha=', fecha, 'motivo=', motivo);

    await pool.query(`
      INSERT INTO mantenimientos (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      SELECT u.id, u.cedis_id, 'PREVENTIVO', ?, ?, u.kilometraje, 1, ?
        FROM unidades u
       WHERE u.id=?`,
      [motivo, fecha, userId, unidadId]
    );
    console.log('[REPROGRAMAR] insert OK');
  }

  // 4) Liberar unidad si no tiene otros abiertos
  if (unidadId) {
    const [[ab]] = await pool.query(
      `SELECT COUNT(*) as abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL`,
      [unidadId]
    );
    if (!ab?.abiertos) {
      await pool.query(`UPDATE unidades SET estado='ACTIVA' WHERE id=?`, [unidadId]);
      console.log('[CERRAR] Unidad liberada');
    }
  }

  // Responder: JSON si viene de AJAX, si no, redirect
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ ok: true });
  }
  return res.redirect('/mantenimientos');
});

// ===== IA: Endpoints auxiliares (por si los usas en otros lugares) =====
app.post('/ai/clasificar', async (req, res) => {
  const { motivo, placa, km, cedis_id } = req.body || {};
  const out = await aiClassify({ motivo, placa, km, cedis: cedis_id });
  res.json(out);
});
app.get('/ai/proximo/:placa', async (req, res) => {
  const out = await aiSuggestNext({ pool, placa: req.params.placa });
  res.json(out);
});
app.get('/ai/resumen/:id', async (req, res) => {
  const out = await aiSummarize({ pool, mantId: req.params.id });
  res.json(out);
});

// Programar por IA (una o todas) con separación de 7 días
app.post('/ai/programar', async (req, res) => {
  try {
    const { unidad_id } = req.body || {};
    let unidadesTarget = [];

    if (unidad_id) {
      const [u] = await pool.query(`SELECT * FROM unidades WHERE id=?`, [unidad_id]);
      if (u?.length) unidadesTarget = [u[0]];
    } else {
      const [uu] = await pool.query(`SELECT * FROM unidades WHERE estado!='INACTIVA' ORDER BY placa`);
      unidadesTarget = uu || [];
    }

    for (const u of unidadesTarget) {
      const plan      = await aiPreventivePlan({ pool, unidadId: u.id });
      const candidata = atLeastTomorrow(avoidSunday(plan.fecha_sugerida));
      const fecha     = await findNextSpacedDateDB(candidata, 7);
      const motivo    = plan.motivo_sugerido || `Plan preventivo: ${(plan.tareas || []).join(', ')}`;

      await pool.query(
        `INSERT INTO mantenimientos (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?,?,?,?,?,1,?)`,
        [u.id, u.cedis_id || null, 'PREVENTIVO', motivo, fecha, u.kilometraje || null, (req.session.user?.id || 1)]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('ai/programar error', e);
    res.status(500).json({ ok: false, error: 'No se pudo programar automáticamente.' });
  }
});

// ===== API para Power BI =====
app.get('/api/mantenimientos', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT m.id, u.placa, c.nombre as cedis, m.tipo, m.motivo, m.fecha_inicio, m.fecha_fin,
           m.duracion_dias, m.km_al_entrar,
           CASE WHEN m.fecha_fin IS NULL THEN 1 ELSE 0 END as en_taller
    FROM mantenimientos m
    JOIN unidades u ON u.id=m.unidad_id
    LEFT JOIN cedis c ON c.id=m.cedis_id
    ORDER BY m.id DESC
  `);
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor en http://localhost:${PORT}`));
