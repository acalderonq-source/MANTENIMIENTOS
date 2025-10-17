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

// ===== Vistas / Middlewares =====
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

// Helpers en vistas
app.use((_, res, next) => {
  res.locals.dayjs = dayjs;
  next();
});

// ====== Helpers “IA” (reglas) ======
const WORK_RULES = {
  'Cambio de aceite': { dias: 45 },
  'Filtro de aire': { dias: 60 },
  'Pastillas/frenos': { dias: 30 },
  'Alineación/balanceo': { dias: 60 },
  'Rotación de llantas': { dias: 90 },
  'Líquidos (freno/refrigerante)': { dias: 60 },
  'Revisión general': { dias: 45 },
};
// ====== IA basada en último trabajo hecho ======

// Normaliza texto (acentos, mayúsculas, etc.)
function norm(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toUpperCase().trim();
}

// Extrae lista de trabajos desde el campo motivo (busca "Hecho: a, b, c")
function extraerTrabajosDeMotivo(motivo='') {
  const m = motivo.match(/Hecho:\s*([^|]+)/i);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

// Reglas simples por trabajo anterior -> sugerencias + días
// Puedes ajustar días y sugerencias a tu operación real.
const TASK_RULES = [
  {
    match: /ACEITE|FILTRO DE ACEITE/,
    sugerencias: ['Revisión frenos', 'Inspección niveles', 'Chequeo fugas'],
    dias: 90
  },
  {
    match: /FRENOS|PASTILLAS|ZAPATAS|DISCOS/,
    sugerencias: ['Balanceo y alineación', 'Inspección suspensión', 'Ajuste frenos'],
    dias: 60
  },
  {
    match: /LLANTAS|NEUMATICOS|BALANCEO|ALINEACION/,
    sugerencias: ['Revisión presión', 'Inspección desgaste', 'Rotación de llantas'],
    dias: 75
  },
  {
    match: /SUSPENSION|AMORTIGUADORES|BUJES/,
    sugerencias: ['Inspección dirección', 'Revisión terminales', 'Parrillas/horquillas'],
    dias: 120
  },
  {
    match: /BATERIA|ELECTRICO|ALTERNADOR|ARRANQUE/,
    sugerencias: ['Prueba de carga', 'Limpieza bornes', 'Verificación alternador'],
    dias: 120
  },
  {
    match: /FILTRO DE AIRE|FILTRO DE COMBUSTIBLE/,
    sugerencias: ['Inspección admisión', 'Revisión inyección', 'Chequeo consumo'],
    dias: 90
  },
  // Fallback por trabajos preventivos genéricos
  {
    match: /PREVENTIVO|SERVICIO|CHECKLIST/,
    sugerencias: ['Inspección general', 'Lubricación puntos', 'Reapriete tornillería'],
    dias: 45
  }
];

// Dada una lista de trabajos anteriores, calcula sugerencias y días
function sugerenciasDesdeTrabajos(trabajos=[]) {
  const tNorms = trabajos.map(norm);
  let dias = 45; // valor por defecto
  const setSug = new Set();

  // Intenta emparejar reglas por el primer match que encuentre
  for (const t of tNorms) {
    for (const rule of TASK_RULES) {
      if (rule.match.test(t)) {
        rule.sugerencias.forEach(s => setSug.add(s));
        // toma el mínimo “hacia delante”: si venías de algo más sensible, respeta su ciclo
        dias = Math.min(dias, rule.dias);
      }
    }
  }

  // Si no hubo match en reglas, sugiere algo seguro
  if (setSug.size === 0) {
    ['Inspección general', 'Revisión niveles', 'Chequeo visual'].forEach(s => setSug.add(s));
    dias = 45;
  }

  return { sugerencias: Array.from(setSug), dias };
}

function diasBasePorTrabajos(trabajos = []) {
  let dias = 45; // base default
  const t = (trabajos || []).filter(Boolean);
  if (t.length === 0) return dias;
  const cand = t.map((x) => WORK_RULES[x]?.dias).filter(Boolean);
  if (cand.length) dias = Math.min(...cand);
  return dias;
}

function esDomingo(d) {
  return dayjs(d).day() === 0;
}

function siguienteHabil(fecha) {
  let d = dayjs(fecha);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}

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

function espaciar7dias(fechaISO, setFechas) {
  let f = dayjs(fechaISO);
  const colisiona = (cand) => {
    const c = dayjs(cand);
    for (const val of setFechas) {
      const d = dayjs(val);
      if (Math.abs(c.diff(d, 'day')) < 7) return true;
    }
    return false;
  };
  while (esDomingo(f) || colisiona(f)) {
    f = f.add(1, 'day');
  }
  return f;
}

async function proximaFechaPorIA({ unidadId, trabajos }) {
  const [hist] = await pool.query(
    `SELECT id, tipo, fecha_inicio, fecha_fin
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
      LIMIT 1`,
    [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;

  let dBase = diasBasePorTrabajos(trabajos);
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    dBase = Math.min(dBase, 30);
  }

  const base = ultimo ? (ultimo.fecha_fin || ultimo.fecha_inicio) : dayjs().format('YYYY-MM-DD');
  let candidata = dayjs(base).add(dBase, 'day');

  const setFechas = await obtenerFechasProgramadas();
  candidata = siguienteHabil(candidata);
  candidata = espaciar7dias(candidata, setFechas);

  return candidata.format('YYYY-MM-DD');
}

// ====== Auth simple ======
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

// ====== Dashboard ======
app.get('/', async (req, res) => {
  try {
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);

    const [mants] = await pool.query(`
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin
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

// ====== Unidades (con filtro Cede y programar IA) ======
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id || '';
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let unidades = [];
    if (cedisId) {
      const [rows] = await pool.query(
        `SELECT u.*, c.nombre AS cedis_nombre
           FROM unidades u
           LEFT JOIN cedis c ON c.id=u.cedis_id
          WHERE u.cedis_id=?
          ORDER BY u.placa`,
        [cedisId]
      );
      unidades = rows;
    } else {
      const [rows] = await pool.query(
        `SELECT u.*, c.nombre AS cedis_nombre
           FROM unidades u
           LEFT JOIN cedis c ON c.id=u.cedis_id
          ORDER BY u.placa`
      );
      unidades = rows;
    }

    res.render('unidades', { title: 'Unidades', cedis, cedisId, unidades });
  } catch (e) {
    console.error('unidades error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

// programar por IA una unidad concreta
app.post('/unidades/:id/programar', async (req, res) => {
  try {
    const unidadId = Number(req.params.id);
    const [[unidad]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!unidad) return res.status(404).send('Unidad no encontrada');

    const fecha = await proximaFechaPorIA({ unidadId, trabajos: [] });

    await pool.query(
      `INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
       VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
      [unidadId, unidad.cedis_id || null, fecha, unidad.kilometraje || null, req.session.user?.id || null]
    );

    res.redirect('/unidades');
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).send('No se pudo programar la unidad');
  }
});

// ====== Mantenimientos abiertos e historial ======
// Filtro por cede + acciones (programar cede completa / eliminar / cerrar / no realizado)
app.get('/mantenimientos', async (req, res) => {
  try {
    fetch('/api/ia/sugerencias/' + id)
  .then(r => r.json())
  .then(d => {
    // Mostrar sugerencias y pre-seleccionarlas como “propuesta”
    const box = document.getElementById('sug-' + id);
    if (d.sugerencias?.length) {
      box.innerHTML = 'Sugerido por IA: ' + d.sugerencias.join(', ');
      d.sugerencias.forEach(s => {
        const input = dlg.querySelector('input[type=checkbox][value="'+s+'"]');
        if (input) input.checked = true;
      });
    } else {
      box.innerHTML = 'Sin sugerencias.';
    }
    // También podrías pre-rellenar una fecha en un input hidden si quieres
    const f = dlg.querySelector('input[name=fecha_siguiente]');
    if (f && d.fecha_sugerida) f.value = d.fecha_sugerida;
  });

    const cedisId = req.query.cedis_id || '';
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let abiertos = [];
    if (cedisId) {
      const [rows] = await pool.query(`
        SELECT m.*, u.placa, c.nombre AS cedis_nombre
          FROM mantenimientos m
          JOIN unidades u ON u.id=m.unidad_id
          LEFT JOIN cedis c ON c.id=m.cedis_id
         WHERE m.fecha_fin IS NULL
           AND (m.cedis_id = ? OR u.cedis_id = ?)
         ORDER BY m.id DESC
      `, [cedisId, cedisId]);
      abiertos = rows;
    } else {
      const [rows] = await pool.query(`
        SELECT m.*, u.placa, c.nombre AS cedis_nombre
          FROM mantenimientos m
          JOIN unidades u ON u.id=m.unidad_id
          LEFT JOIN cedis c ON c.id=m.cedis_id
         WHERE m.fecha_fin IS NULL
         ORDER BY m.id DESC
      `);
      abiertos = rows;
    }

    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos, cedis, cedisId });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// Programar por IA todas las unidades de una CEDE
app.post('/mantenimientos/programar-cede', async (req, res) => {
  try {
    const cedisId = Number(req.body.cedis_id);
    if (!cedisId) return res.status(400).send('cedis_id requerido');

    // Unidades de la cede
    const [unidades] = await pool.query(
      `SELECT * FROM unidades WHERE cedis_id=? ORDER BY placa`,
      [cedisId]
    );
    if (!Array.isArray(unidades) || unidades.length === 0) {
      return res.redirect('/mantenimientos?cedis_id=' + cedisId);
    }

    // Empezar con fechas ya programadas para respetar separación
    const setFechas = await obtenerFechasProgramadas();

    for (const u of unidades) {
      // Evitar duplicar si ya tiene abierto
      const [[ab]] = await pool.query(
        `SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL`,
        [u.id]
      );
      if ((ab?.abiertos || 0) > 0) continue;

      // Proponer fecha con reglas (sin trabajos específicos)
      const [hist] = await pool.query(
        `SELECT id, tipo, fecha_inicio, fecha_fin
           FROM mantenimientos
          WHERE unidad_id=?
          ORDER BY id DESC LIMIT 1`,
        [u.id]
      );
      const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;
      let baseDias = 45;
      if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') baseDias = 30;

      let base = ultimo ? (ultimo.fecha_fin || ultimo.fecha_inicio) : dayjs().format('YYYY-MM-DD');
      let candidata = dayjs(base).add(baseDias, 'day');
      candidata = siguienteHabil(candidata);
      candidata = espaciar7dias(candidata, setFechas);

      const fecha = candidata.format('YYYY-MM-DD');

      await pool.query(
        `INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido (cede)', ?, ?, 1, ?)`,
        [u.id, u.cedis_id || cedisId, fecha, u.kilometraje || null, req.session.user?.id || null]
      );

      // bloquear esa fecha para siguientes unidades (espaciado)
      setFechas.add(fecha);
    }

    res.redirect('/mantenimientos?cedis_id=' + cedisId);
  } catch (e) {
    console.error('programar-cede error', e);
    res.status(500).send('No se pudo programar la cede');
  }
});

// ====== Historial ======
app.get('/historial', async (req, res) => {
  try {
    const [cerrados] = await pool.query(`
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id=m.cedis_id
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
        JOIN unidades u ON u.id=m.unidad_id
        LEFT JOIN cedis c ON c.id=m.cedis_id
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

// ====== Cerrar y reprogramar (con checklist) ======
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

    // NO tocar duracion_dias (si es columna generada)
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

    // Liberar unidad si no tiene otros abiertos
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

      // Reprogramar con reglas según trabajos
      const fechaProgramada = await proximaFechaPorIA({ unidadId, trabajos });
      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', ?, ?, ?, 1, ?)
      `,
        [
          unidadId,
          mant.cedis_id || null,
          trabajos.length ? `Plan preventivo sugerido tras: ${trabajos.join(', ')}` : 'Plan preventivo sugerido',
          fechaProgramada,
          mant.km_al_entrar || null,
          req.session.user?.id || null,
        ]
      );
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// ====== No se realizó (cierra SIN reprogramar) ======
app.post('/mantenimientos/:id/no-realizado', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');
    const hoy = dayjs().format('YYYY-MM-DD');

    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin=?,
             reservado_inventario=0,
             motivo = CONCAT(COALESCE(motivo,''), ' | NO REALIZADO')
       WHERE id=?
      `,
      [hoy, mantId]
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
        await pool.query("UPDATE unidades SET estado='ACTIVA' WHERE id=?", [unidadId]);
      }
    }

    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('no-realizado error', e);
    res.status(500).send('No se pudo marcar como no realizado');
  }
});

// ====== Eliminar mantenimiento ======
app.delete('/mantenimientos/:id', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [mantId]);
    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('eliminar mant error', e);
    res.status(500).send('No se pudo eliminar');
  }
});

// ====== Endpoint opcional: sugerencias rápidas de trabajos por mantId ======
app.get('/api/ia/sugerencias/:mantId', async (req, res) => {
  try {
    // GET /api/ia/sugerencias/:mantId
// Retorna: { sugerencias: [..], fecha_sugerida: 'YYYY-MM-DD', basado_en: [trabajos] }
app.get('/api/ia/sugerencias/:mantId', async (req, res) => {
  try {
    const mantId = Number(req.params.mantId);
    if (!mantId) return res.status(400).json({ error: 'mantId inválido' });

    // 1) Trae el mantenimiento actual para ubicar la unidad
    const [[actual]] = await pool.query('SELECT id, unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    if (!actual) return res.status(404).json({ error: 'Mantenimiento no encontrado' });

    // 2) Busca el mantenimiento anterior (cerrado) de esa unidad (id < actual)
    const [prevs] = await pool.query(`
      SELECT id, tipo, fecha_inicio, fecha_fin, motivo
        FROM mantenimientos
       WHERE unidad_id = ?
         AND fecha_fin IS NOT NULL
         AND id < ?
       ORDER BY id DESC
       LIMIT 1
    `, [actual.unidad_id, mantId]);

    let trabajosPrev = [];
    let baseFecha = dayjs(); // si no hay anterior, partimos de hoy
    if (prevs && prevs[0]) {
      trabajosPrev = extraerTrabajosDeMotivo(prevs[0].motivo || '');
      baseFecha = dayjs(prevs[0].fecha_fin || prevs[0].fecha_inicio || dayjs());
    }

    // 3) Calcula sugerencias y días desde trabajos previos
    const { sugerencias, dias } = sugerenciasDesdeTrabajos(trabajosPrev);

    // 4) Aplica tu lógica de fecha (evitar domingo + espaciar 7 días)
    const setFechas = await obtenerFechasProgramadas(); // usa la función que ya tienes
    let fecha = baseFecha.add(dias, 'day');
    while (fecha.day() === 0) fecha = fecha.add(1, 'day'); // evita domingo
    // espaciar 7 días
    const colisiona = (cand) => {
      const c = dayjs(cand);
      for (const val of setFechas) {
        const d = dayjs(val);
        const diff = Math.abs(c.diff(d, 'day'));
        if (diff < 7) return true;
      }
      return false;
    };
    while (colisiona(fecha)) fecha = fecha.add(1, 'day');

    res.json({
      sugerencias,
      fecha_sugerida: fecha.format('YYYY-MM-DD'),
      basado_en: trabajosPrev
    });
  } catch (e) {
    console.error('ia/sugerencias error', e);
    res.status(500).json({ error: 'No se pudieron generar sugerencias' });
  }
});

    const mantId = Number(req.params.mantId);
    const [[m]] = await pool.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    if (!m) return res.json({ sugerencias: [] });

    // Heurística simple por tiempo desde último cierre
    const [last] = await pool.query(
      `
      SELECT fecha_fin, fecha_inicio
        FROM mantenimientos
       WHERE unidad_id=?
         AND fecha_fin IS NOT NULL
       ORDER BY id DESC
       LIMIT 1
      `,
      [m.unidad_id]
    );

    const ref = last?.[0]?.fecha_fin || last?.[0]?.fecha_inicio;
    const dias = ref ? dayjs().diff(dayjs(ref), 'day') : 9999;

    const sug = new Set(['Revisión general']);
    if (dias >= 30) sug.add('Pastillas/frenos');
    if (dias >= 45) sug.add('Cambio de aceite');
    if (dias >= 60) {
      sug.add('Filtro de aire');
      sug.add('Alineación/balanceo');
      sug.add('Líquidos (freno/refrigerante)');
    }
    if (dias >= 90) sug.add('Rotación de llantas');

    res.json({ sugerencias: Array.from(sug) });
  } catch (e) {
    res.json({ sugerencias: [] });
  }
});

// ====== API diagnósticos ======
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/debug/db', async (_, res) => {
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

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
