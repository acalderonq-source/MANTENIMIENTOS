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
   Motor de vistas & middlewares
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

// Helpers para las vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* =========================
   Utilidades de programación
   ========================= */

// domingo?
const esDomingo = (iso) => dayjs(iso).day() === 0;
// siguiente hábil (evita domingo)
const siguienteHabil = (iso) => {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
};

// Fechas programadas (abiertas con fecha_inicio)
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

// separa >= 7 días de cualquier otra programada
function espaciar7dias(fechaISO, setFechas) {
  const colisiona = (cand) => {
    const c = dayjs(cand);
    for (const val of setFechas) {
      const d = dayjs(val);
      if (Math.abs(c.diff(d, 'day')) < 7) return true;
    }
    return false;
  };
  let f = dayjs(fechaISO);
  while (esDomingo(f) || colisiona(f)) f = f.add(1, 'day');
  return f;
}

// regla base por número de entradas
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 35;
  if (veces >= 3) return 40;
  return 45;
}

// próxima fecha preventiva para una unidad (usa 45/40/35, evita domingo, separa 7d)
async function calcularProximaFecha(unidadId) {
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

  let baseDias = diasBasePorVeces(veces || 0);
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    baseDias = Math.min(baseDias, 30);
  }

  let baseFecha = ultimo
    ? dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(baseDias, 'day')
    : dayjs().add(baseDias, 'day');

  const setFechas = await obtenerFechasProgramadas();
  const fecha = espaciar7dias(siguienteHabil(baseFecha), setFechas);
  return fecha.format('YYYY-MM-DD');
}

/* =========================
   IA (sugerencias según lo hecho antes)
   ========================= */

function norm(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

// extrae “Hecho: …” de motivo
function extraerTrabajosDeMotivo(motivo = '') {
  const m = motivo.match(/Hecho:\s*([^|]+)/i);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// reglas simples por último trabajo -> sugerencias + días
const TASK_RULES = [
  {
    match: /ACEITE|FILTRO DE ACEITE/,
    sugerencias: ['Revisión frenos', 'Inspección niveles', 'Chequeo fugas'],
    dias: 90,
  },
  {
    match: /FRENOS|PASTILLAS|ZAPATAS|DISCOS/,
    sugerencias: ['Balanceo y alineación', 'Inspección suspensión', 'Ajuste frenos'],
    dias: 60,
  },
  {
    match: /LLANTAS|NEUMATICOS|BALANCEO|ALINEACION/,
    sugerencias: ['Revisión presión', 'Inspección desgaste', 'Rotación de llantas'],
    dias: 75,
  },
  {
    match: /SUSPENSION|AMORTIGUADORES|BUJES/,
    sugerencias: ['Inspección dirección', 'Revisión terminales', 'Parrillas/horquillas'],
    dias: 120,
  },
  {
    match: /BATERIA|ELECTRICO|ALTERNADOR|ARRANQUE/,
    sugerencias: ['Prueba de carga', 'Limpieza bornes', 'Verificación alternador'],
    dias: 120,
  },
  {
    match: /FILTRO DE AIRE|FILTRO DE COMBUSTIBLE/,
    sugerencias: ['Inspección admisión', 'Revisión inyección', 'Chequeo consumo'],
    dias: 90,
  },
  {
    match: /PREVENTIVO|SERVICIO|CHECKLIST/,
    sugerencias: ['Inspección general', 'Lubricación puntos', 'Reapriete tornillería'],
    dias: 45,
  },
];

function sugerenciasDesdeTrabajos(trabajos = []) {
  const tNorms = trabajos.map(norm);
  let dias = 45;
  const setSug = new Set();
  for (const t of tNorms) {
    for (const rule of TASK_RULES) {
      if (rule.match.test(t)) {
        rule.sugerencias.forEach((s) => setSug.add(s));
        dias = Math.min(dias, rule.dias);
      }
    }
  }
  if (setSug.size === 0) {
    ['Inspección general', 'Revisión niveles', 'Chequeo visual'].forEach((s) => setSug.add(s));
    dias = 45;
  }
  return { sugerencias: Array.from(setSug), dias };
}

// Endpoint IA: sugerencias con base en lo hecho antes + fecha propuesta
app.get('/api/ia/sugerencias/:mantId', async (req, res) => {
  try {
    const mantId = Number(req.params.mantId);
    if (!mantId) return res.status(400).json({ error: 'mantId inválido' });

    const [[actual]] = await pool.query('SELECT id, unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    if (!actual) return res.status(404).json({ error: 'Mantenimiento no encontrado' });

    const [prevs] = await pool.query(
      `SELECT id, tipo, fecha_inicio, fecha_fin, motivo
         FROM mantenimientos
        WHERE unidad_id = ?
          AND fecha_fin IS NOT NULL
          AND id < ?
        ORDER BY id DESC
        LIMIT 1`,
      [actual.unidad_id, mantId]
    );

    let trabajosPrev = [];
    let baseFecha = dayjs();
    if (prevs && prevs[0]) {
      trabajosPrev = extraerTrabajosDeMotivo(prevs[0].motivo || '');
      baseFecha = dayjs(prevs[0].fecha_fin || prevs[0].fecha_inicio || dayjs());
    }

    const { sugerencias, dias } = sugerenciasDesdeTrabajos(trabajosPrev);

    const setFechas = await obtenerFechasProgramadas();
    let fecha = baseFecha.add(dias, 'day');
    while (fecha.day() === 0) fecha = fecha.add(1, 'day');
    const colisiona = (cand) => {
      const c = dayjs(cand);
      for (const val of setFechas) {
        const d = dayjs(val);
        if (Math.abs(c.diff(d, 'day')) < 7) return true;
      }
      return false;
    };
    while (colisiona(fecha)) fecha = fecha.add(1, 'day');

    res.json({
      sugerencias,
      fecha_sugerida: fecha.format('YYYY-MM-DD'),
      basado_en: trabajosPrev,
    });
  } catch (e) {
    console.error('ia/sugerencias error', e);
    res.status(500).json({ error: 'No se pudieron generar sugerencias' });
  }
});

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

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* =========================
   Dashboard
   ========================= */
app.get('/', async (req, res) => {
  try {
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades)                              AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);
    const [mants] = await pool.query(`
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin
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
   Unidades (listar)
   ========================= */
app.get('/unidades', async (req, res) => {
  try {
    const [unidades] = await pool.query(`
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id = u.cedis_id
       ORDER BY u.id DESC
    `);
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');
    res.render('unidades', { title: 'Unidades', unidades, cedis });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

/* =========================
   Mantenimientos: abiertos, historial, por cede
   ========================= */

// Abiertos (opcional filtro cede ?cedis_id=)
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

    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos, cedis, filtroCedisId: cedisId });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// Historial total
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

// Historial por placa
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
   Cerrar / Eliminar / Programar (unidad o cede)
   ========================= */

// Cerrar mantenimiento (guarda “Hecho: …”, libera unidad, reprograma)
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

    // OJO: NO tocamos duracion_dias si es columna generada
    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin=?,
             reservado_inventario=0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id=?`,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

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

    // Reprogramar automático con tu regla
    if (unidadId) {
      // Si UI te mandó una fecha concreta (p.ej. de /api/ia/sugerencias), úsala:
      const fechaSiguiente = (req.body.fecha_siguiente || '').trim();
      const fechaProgramada = fechaSiguiente || (await calcularProximaFecha(unidadId));

      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', ?, ?, ?, 1, ?)`,
        [
          unidadId,
          mant.cedis_id || null,
          'Plan preventivo sugerido',
          fechaProgramada,
          mant.kilometraje || null,
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

// Eliminar mantenimiento
app.post('/mantenimientos/:id/eliminar', async (req, res) => {
  try {
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [req.params.id]);
    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('eliminar mant error', e);
    res.status(500).send('No se pudo eliminar');
  }
});

// Programar por IA una unidad/placa
app.post('/api/ia/programar', async (req, res) => {
  try {
    const { unidad_id, placa } = req.body || {};
    if (!unidad_id && !placa) return res.status(400).json({ error: 'unidad_id o placa requerido' });

    let unidad = null;
    if (unidad_id) {
      const [u1] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidad_id]);
      unidad = u1?.[0] || null;
    } else {
      const [u2] = await pool.query('SELECT * FROM unidades WHERE placa=?', [placa]);
      unidad = u2?.[0] || null;
    }
    if (!unidad) return res.status(404).json({ error: 'Unidad no encontrada' });

    const fecha = await calcularProximaFecha(unidad.id);
    const [r] = await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
      [unidad.id, unidad.cedis_id || null, fecha, unidad.kilometraje || null, req.session.user?.id || null]
    );

    res.json({ ok: true, id: r.insertId, fecha_programada: fecha });
  } catch (e) {
    console.error('api/ia/programar error', e);
    res.status(500).json({ error: 'No se pudo programar' });
  }
});

// Programar toda una cede (distribuye fechas con separación >=7d)
app.post('/mantenimientos/programar-cede', async (req, res) => {
  try {
    const cedis_id = Number(req.body.cedis_id);
    if (!cedis_id) return res.status(400).send('cedis_id requerido');

    const [unidades] = await pool.query(
      `SELECT * FROM unidades WHERE cedis_id=? AND estado!='INACTIVA' ORDER BY placa`,
      [cedis_id]
    );
    if (!Array.isArray(unidades) || unidades.length === 0) {
      return res.redirect('/mantenimientos?cedis_id=' + cedis_id);
    }

    // Punto de partida: para la primera unidad, usa su regla; para las siguientes ve empujando días hasta no chocar en ±7
    let setFechas = await obtenerFechasProgramadas();

    for (const u of unidades) {
      let fecha = dayjs(await calcularProximaFecha(u.id)); // base por unidad (historial)
      // Ensanchar si choca con otra programada (±7)
      const colisiona = (cand) => {
        const c = dayjs(cand);
        for (const val of setFechas) {
          const d = dayjs(val);
          if (Math.abs(c.diff(d, 'day')) < 7) return true;
        }
        return false;
      };
      while (esDomingo(fecha) || colisiona(fecha)) fecha = fecha.add(1, 'day');

      const fechaStr = fecha.format('YYYY-MM-DD');

      const [r] = await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
        [u.id, cedis_id, fechaStr, u.kilometraje || null, req.session.user?.id || null]
      );

      setFechas.add(fechaStr);
    }

    res.redirect('/mantenimientos?cedis_id=' + cedis_id);
  } catch (e) {
    console.error('programar-cede error', e);
    res.status(500).send('No se pudo programar la cede');
  }
});

/* =========================
   API: Próximos (para Power BI/chat)
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
// Render usa 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
