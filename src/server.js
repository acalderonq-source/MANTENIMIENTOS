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
app.set('layout', 'partials/layout'); // usa views/partials/layout.ejs

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

// Helpers a vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  res.locals.toast = req.query.toast || '';
  next();
});

/* =========================
   Reglas de programación preventiva
   ========================= */

// regla base según veces que ha entrado
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 35;
  if (veces >= 3) return 40;
  return 45;
}

// domingo?
function esDomingo(isoDate) {
  const d = dayjs(isoDate);
  return d.day() === 0; // 0 domingo
}

// siguiente día hábil (evita domingo)
function siguienteHabil(isoDate) {
  let d = dayjs(isoDate);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}

// set de fechas ya programadas (abiertas con fecha_inicio)
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

// espaciar 7 días respecto a otras programaciones y evitar domingo
function espaciar7dias(fechaISO, setFechas) {
  let f = dayjs(fechaISO);
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

// capacidad diaria por CEDIS: Cartago/Transportadora => 5; resto => 1
async function capacidadPorCedis(cedisId) {
  if (!cedisId) return 1;
  const [rows] = await pool.query('SELECT nombre FROM cedis WHERE id=?', [cedisId]);
  const nombre = (rows?.[0]?.nombre || '').toUpperCase();
  return nombre.includes('CARTAGO') || nombre.includes('TRANSPORTADORA') ? 5 : 1;
}

// asigna fecha >= base considerando domingo, separación y cupos del CEDIS
async function asignarFechaConCapacidad(cedisId, baseISO) {
  let d = dayjs(baseISO);
  const setFechas = await obtenerFechasProgramadas();
  const cupo = await capacidadPorCedis(cedisId);

  while (true) {
    d = siguienteHabil(d);
    d = espaciar7dias(d, setFechas);
    const fecha = d.format('YYYY-MM-DD');

    const [[{ cnt } = { cnt: 0 }]] = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM mantenimientos
        WHERE cedis_id=? AND fecha_inicio=? AND fecha_fin IS NULL`,
      [cedisId, fecha]
    );
    if ((cnt || 0) < cupo) return fecha;

    d = d.add(1, 'day');
  }
}

// calcula próxima fecha preventiva para una unidad
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

  let baseFecha;
  if (!ultimo) {
    baseFecha = dayjs().add(baseDias, 'day');
  } else {
    baseFecha = dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(baseDias, 'day');
  }

  const setFechas = await obtenerFechasProgramadas();
  let fecha = siguienteHabil(baseFecha);
  fecha = espaciar7dias(fecha, setFechas);
  return fecha.format('YYYY-MM-DD');
}

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

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* =========================
   Dashboard (filtrable por mes)
   ========================= */
app.get('/', async (req, res) => {
  const mes = req.query.mes || dayjs().format('YYYY-MM');
  const inicio = dayjs(mes + '-01');
  const fin = inicio.endOf('month');

  try {
    // KPIs
    const [[kpis]] = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `
    );

    // últimos cerrados del mes y últimos abiertos del mes
    const [mants] = await pool.query(
      `
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE (m.fecha_inicio BETWEEN ? AND ?)
          OR (m.fecha_fin BETWEEN ? AND ?)
       ORDER BY m.id DESC
       LIMIT 20
    `,
      [inicio.format('YYYY-MM-DD'), fin.format('YYYY-MM-DD'), inicio.format('YYYY-MM-DD'), fin.format('YYYY-MM-DD')]
    );

    res.render('dashboard', { title: 'Dashboard', kpis, mants, mes });
  } catch (e) {
    console.error('dashboard error', e);
    res.status(500).send('Error cargando dashboard');
  }
});

/* =========================
   Unidades
   ========================= */
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedisId || '';
    const placa = (req.query.q || '').trim();

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let where = '1=1';
    const params = [];
    if (cedisId) {
      where += ' AND u.cedis_id = ?';
      params.push(cedisId);
    }
    if (placa) {
      where += ' AND u.placa LIKE ?';
      params.push(`%${placa}%`);
    }

    const [unidades] = await pool.query(
      `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id = u.cedis_id
       WHERE ${where}
       ORDER BY u.id DESC
    `,
      params
    );

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId, q: placa });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

// Programar UNA unidad (respeta reglas y cupos del CEDIS)
app.post('/unidades/:id/programar', async (req, res) => {
  try {
    const unidadId = Number(req.params.id);
    if (!unidadId) return res.status(400).send('Unidad inválida');

    const [[unidad]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!unidad) return res.status(404).send('Unidad no encontrada');

    const base = await calcularProximaFecha(unidadId);
    const cedisId = unidad.cedis_id || null;
    const fechaProgramada = cedisId ? await asignarFechaConCapacidad(cedisId, base) : base;

    await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Programado manualmente', ?, ?, 1, ?)
    `,
      [unidadId, cedisId, fechaProgramada, unidad.kilometraje || null, req.session.user?.id || null]
    );

    await pool.query("UPDATE unidades SET estado='EN_TALLER' WHERE id=?", [unidadId]);

    return res.redirect(
      `/mantenimientos?toast=Programado%20${encodeURIComponent(unidad.placa)}%20para%20${fechaProgramada}`
    );
  } catch (e) {
    console.error('POST /unidades/:id/programar error', e);
    return res.status(500).send('No se pudo programar la unidad');
  }
});

// Programar TODAS las unidades ACTIVAS de un CEDIS (respetando cupos)
app.post('/cedis/:cedisId/programar', async (req, res) => {
  try {
    const cedisId = Number(req.params.cedisId);
    if (!cedisId) return res.status(400).send('CEDIS inválido');

    const [unidades] = await pool.query(
      `
      SELECT u.*
        FROM unidades u
       WHERE u.cedis_id=? AND u.estado='ACTIVA'
         AND NOT EXISTS (
           SELECT 1 FROM mantenimientos m
            WHERE m.unidad_id=u.id AND m.fecha_fin IS NULL
         )
       ORDER BY u.id
    `,
      [cedisId]
    );

    let ok = 0;
    for (const u of unidades || []) {
      const base = await calcularProximaFecha(u.id);
      const fecha = await asignarFechaConCapacidad(cedisId, base);
      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Programado por CEDIS', ?, ?, 1, ?)
      `,
        [u.id, cedisId, fecha, u.kilometraje || null, req.session.user?.id || null]
      );
      await pool.query("UPDATE unidades SET estado='EN_TALLER' WHERE id=?", [u.id]);
      ok++;
    }

    return res.redirect(`/mantenimientos?toast=Programadas%20${ok}%20unidades`);
  } catch (e) {
    console.error('POST /cedis/:cedisId/programar error', e);
    return res.status(500).send('No se pudo programar por CEDIS');
  }
});

/* =========================
   Mantenimientos: abiertos del mes, historial, acciones
   ========================= */

// list de abiertos del MES (filtro por CEDIS + búsqueda placa)
app.get('/mantenimientos', async (req, res) => {
  try {
    const mes = req.query.mes || dayjs().format('YYYY-MM');
    const cedisId = req.query.cedisId || '';
    const placa = (req.query.q || '').trim();

    const inicio = dayjs(mes + '-01').format('YYYY-MM-DD');
    const fin = dayjs(mes + '-01').endOf('month').format('YYYY-MM-DD');

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let where = `m.fecha_fin IS NULL AND (m.fecha_inicio BETWEEN ? AND ?)`;
    const params = [inicio, fin];

    if (cedisId) {
      where += ' AND m.cedis_id = ?';
      params.push(cedisId);
    }
    if (placa) {
      where += ' AND u.placa LIKE ?';
      params.push(`%${placa}%`);
    }

    const [abiertos] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE ${where}
       ORDER BY m.fecha_inicio ASC, m.id DESC
    `,
      params
    );

    res.render('mantenimientos_list', {
      title: 'Mantenimientos abiertos',
      mants: abiertos,
      cedis,
      cedisId,
      q: placa,
      mes,
    });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// historial completo (cerrados), con filtros opcionales
app.get('/historial', async (req, res) => {
  try {
    const placa = (req.query.q || '').trim();
    const cedisId = req.query.cedisId || '';

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let where = 'm.fecha_fin IS NOT NULL';
    const params = [];
    if (cedisId) {
      where += ' AND m.cedis_id = ?';
      params.push(cedisId);
    }
    if (placa) {
      where += ' AND u.placa LIKE ?';
      params.push(`%${placa}%`);
    }

    const [cerrados] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE ${where}
       ORDER BY m.fecha_fin DESC, m.id DESC
    `,
      params
    );
    res.render('historial', { title: 'Historial', mants: cerrados, cedis, cedisId, q: placa });
  } catch (e) {
    console.error('historial error', e);
    res.status(500).send('No se pudo cargar historial');
  }
});

// historial por placa
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

// Cerrar y reprogramar (elige trabajos en el front; aquí procesamos)
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  const mantId = Number(req.params.id);
  try {
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');

    // trabajos y comentario
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();
    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // NO toques columnas generadas como duracion_dias
    await pool.query(
      `
      UPDATE mantenimientos
         SET fecha_fin = ?,
             reservado_inventario = 0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id = ?
    `,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    // liberar unidad si no hay otro abierto
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

      // reprogramar preventivo (fecha prudente y cupo por CEDIS)
      const base = await calcularProximaFecha(unidadId);

      const [[u]] = await pool.query('SELECT cedis_id, kilometraje FROM unidades WHERE id=?', [unidadId]);
      const cedisId = u?.cedis_id || mant.cedis_id || null;
      const fechaProgramada = cedisId ? await asignarFechaConCapacidad(cedisId, base) : base;

      await pool.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [unidadId, cedisId, fechaProgramada, u?.kilometraje || null, req.session.user?.id || null]
      );
    }

    res.redirect('/mantenimientos?toast=Cerrado%20y%20reprogramado');
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// Eliminar mantenimiento (solo si está cerrado o si lo permites abierto)
app.post('/mantenimientos/:id/delete', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send('ID inválido');

    // si eliminas abiertos, podrías devolver la unidad a ACTIVA si no quedan más
    const [[m]] = await pool.query('SELECT unidad_id, fecha_fin FROM mantenimientos WHERE id=?', [id]);
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [id]);

    if (m?.unidad_id) {
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [m.unidad_id]
      );
      if ((ab?.abiertos || 0) === 0) {
        await pool.query("UPDATE unidades SET estado='ACTIVA' WHERE id=?", [m.unidad_id]);
      }
    }

    res.redirect('/mantenimientos?toast=Eliminado');
  } catch (e) {
    console.error('delete mant error', e);
    res.status(500).send('No se pudo eliminar mantenimiento');
  }
});

/* =========================
   API auxiliares
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
   404 + errores (fallbacks)
   ========================= */
app.use((req, res) => {
  res.status(404).send('Ruta no encontrada');
});

app.use((err, req, res, next) => {
  console.error('🔥 Unhandled error:', err);
  res.status(500).send('Internal Server Error');
});

/* =========================
   Start
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
