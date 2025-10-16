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

// ====== Motor de vistas y middlewares ======
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

// Helpers a vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

// ====== Utils de programación preventiva ======

// Regla base por cantidad de entradas
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 35;
  if (veces >= 3) return 40;
  return 45;
}

// ¿Es domingo?
function esDomingo(isoDate) {
  const d = dayjs(isoDate);
  return d.day() === 0; // 0 = Sunday
}

// Siguiente día hábil (evita domingo)
function siguienteHabil(isoDate) {
  let d = dayjs(isoDate);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}

// Obtiene fechas ya programadas (abiertas con fecha_inicio)
async function obtenerFechasProgramadas() {
  const [rows] = await pool.query(`
    SELECT fecha_inicio
      FROM mantenimientos
     WHERE fecha_fin IS NULL
       AND fecha_inicio IS NOT NULL
  `);
  // Retorna set con 'YYYY-MM-DD'
  return new Set(
    (rows || [])
      .map(r => r.fecha_inicio)
      .filter(Boolean)
      .map(f => dayjs(f).format('YYYY-MM-DD'))
  );
}

// Asegura spacing de 7 días con lo ya programado
function espaciar7dias(fechaISO, setFechas) {
  let f = dayjs(fechaISO);
  // mientras domingo o colisione con ±6 días de otra fecha, corre 1 día
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

// Calcula la próxima fecha preventiva para una unidad
async function calcularProximaFecha(unidadId) {
  // veces que ha entrado
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?', [unidadId]
  );

  // último mantenimiento (para tipo/fecha base)
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

  let baseFecha;
  if (!ultimo) {
    // sin historial → hoy + base
    baseFecha = dayjs().add(baseDias, 'day');
  } else {
    baseFecha = dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(baseDias, 'day');
  }

  // Evitar domingo y espaciar 7 días frente a otras programaciones
  const setFechas = await obtenerFechasProgramadas();
  let fecha = siguienteHabil(baseFecha);
  fecha = espaciar7dias(fecha, setFechas);

  return fecha.format('YYYY-MM-DD');
}

// ====== Auth mínimo (opcional) ======
app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    // Ajusta a tu esquema real de usuarios
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.password_hash, r.nombre AS rol
        FROM usuarios u
        JOIN roles r ON r.id = u.rol_id
       WHERE u.username = ? AND u.activo = 1
    `, [username]);

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

// ====== Dashboard mínimo ======
app.get('/', async (req, res) => {
  try {
    // KPIs simples
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades)                              AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);
    // últimos 10
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

// ====== Unidades ======
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

// ====== Mantenimientos: abiertos e historial ======
app.get('/mantenimientos', async (req, res) => {
  try {
    const [abiertos] = await pool.query(`
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE m.fecha_fin IS NULL
       ORDER BY m.id DESC
    `);
    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

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
    const [rows] = await pool.query(`
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE u.placa = ?
       ORDER BY m.id DESC
    `, [placa]);
    res.render('historial_placa', { title: `Historial ${placa}`, mants: rows, placa });
  } catch (e) {
    console.error('historial placa error', e);
    res.status(500).send('No se pudo cargar historial por placa');
  }
});

// ====== API: cerrar mantenimiento y reprogramar automático ======
// Espera body: { trabajos: [string], comentario: string }
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    // 1) Traer mantenimiento
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');

    // 2) Cerrar mantenimiento (duración y “qué se le hizo” en motivo)
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();
    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // actualiza fecha_fin y duración
    await pool.query(`
      UPDATE mantenimientos
         SET fecha_fin = ?,
             duracion_dias = DATEDIFF(?, fecha_inicio),
             motivo = CONCAT(COALESCE(motivo,''), ? , ?)
       WHERE id = ?
    `, [hoy, hoy, hechoTxt, comentarioTxt, mantId]);

    // 3) Liberar unidad si no tiene otros abiertos
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

    // 4) Reprogramar preventivo automático (no domingo, 7 días de separación)
    if (unidadId) {
      const fechaProgramada = await calcularProximaFecha(unidadId);
      await pool.query(`
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', ?, ?, ?, 1, ?)
      `, [
        unidadId,
        mant.cedis_id || null,
        'Plan preventivo sugerido',
        fechaProgramada,
        mant.km_al_entrar || null,
        req.session.user?.id || null
      ]);
    }

    // 5) Redirigir a lista/historial
    res.redirect('/mantenimientos');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// ====== API: programar por IA (reglas internas) para una placa o unidad ======
app.post('/api/ia/programar', async (req, res) => {
  try {
    const { unidad_id, placa } = req.body || {};
    if (!unidad_id && !placa) return res.status(400).json({ error: 'unidad_id o placa requerido' });

    // localizar unidad
    let unidad = null;
    if (unidad_id) {
      const [u1] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidad_id]);
      unidad = u1?.[0] || null;
    } else if (placa) {
      const [u2] = await pool.query('SELECT * FROM unidades WHERE placa=?', [placa]);
      unidad = u2?.[0] || null;
    }
    if (!unidad) return res.status(404).json({ error: 'Unidad no encontrada' });

    const fecha = await calcularProximaFecha(unidad.id);

    const [r] = await pool.query(`
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
    `, [
      unidad.id,
      unidad.cedis_id || null,
      fecha,
      unidad.kilometraje || null,
      null
    ]);

    res.json({ ok: true, id: r.insertId, fecha_programada: fecha });
  } catch (e) {
    console.error('api/ia/programar error', e);
    res.status(500).json({ error: 'No se pudo programar' });
  }
});

// ====== API: top próximos (para chatbot/botón IA si lo usas) ======
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

// ====== Diagnóstico ======
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

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
