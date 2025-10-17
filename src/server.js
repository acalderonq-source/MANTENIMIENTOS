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

/* ===========================
   Motor de vistas y middlewares
=========================== */
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

// Helpers para vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.dayjs = dayjs;
  next();
});

/* ===========================
   Utilidades de fecha / programación
=========================== */
function esDomingo(d) {
  return dayjs(d).day() === 0;
}
function siguienteHabil(d) {
  let f = dayjs(d);
  while (f.day() === 0) f = f.add(1, 'day'); // evita domingo
  return f;
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
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 28;
  if (veces >= 3) return 30;
  return 30;
}

// Fecha preventiva con tope de 30 días, sin domingo, separada 7 días de otras
async function calcularProximaFecha(unidadId /*, cedisId = null */) {
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?',
    [unidadId]
  );

  const [hist] = await pool.query(
    `
    SELECT id, tipo, fecha_inicio, fecha_fin
      FROM mantenimientos
     WHERE unidad_id=?
     ORDER BY id DESC
     LIMIT 1
  `,
    [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist.length ? hist[0] : null;

  let baseDias = diasBasePorVeces(veces || 0);
  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    baseDias = Math.min(baseDias, 25); // si fue correctivo, tráela antes
  }

  const hoy = dayjs();
  const maxPermitido = hoy.add(30, 'day'); // TOPE duro 30 días
  let candidata = ultimo
    ? dayjs(ultimo.fecha_fin || ultimo.fecha_inicio).add(baseDias, 'day')
    : hoy.add(baseDias, 'day');

  if (candidata.isAfter(maxPermitido, 'day')) candidata = maxPermitido;
  candidata = siguienteHabil(candidata);

  const fechas = await obtenerFechasProgramadas();
  const colisiona = (cand) => {
    const c = dayjs(cand);
    for (const f of fechas) {
      const d = dayjs(f);
      if (Math.abs(c.diff(d, 'day')) < 7) return true; // evita ±6 días
    }
    return false;
  };
  while (esDomingo(candidata) || colisiona(candidata)) {
    candidata = candidata.add(1, 'day');
    if (candidata.diff(maxPermitido, 'day') > 0) {
      candidata = siguienteHabil(maxPermitido);
    }
  }
  return candidata.format('YYYY-MM-DD');
}

/* ===========================
   Auth mínimo
=========================== */
app.get('/login', (req, res) => {
  res.render('login', { title: 'Iniciar sesión' });
});

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
      return res.render('login', {
        title: 'Iniciar sesión',
        error: 'Usuario o contraseña inválidos',
      });
    }
    const bcrypt = (await import('bcryptjs')).default;
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) {
      return res.render('login', {
        title: 'Iniciar sesión',
        error: 'Usuario o contraseña inválidos',
      });
    }
    req.session.user = {
      id: rows[0].id,
      username: rows[0].username,
      rol: rows[0].rol,
    };
    res.redirect('/');
  } catch (e) {
    console.error('login error', e);
    res.render('login', { title: 'Iniciar sesión', error: 'No se pudo iniciar sesión' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ===========================
   Dashboard (filtro por mes)
=========================== */
app.get('/', async (req, res) => {
  try {
    const mes = req.query.mes || dayjs().format('YYYY-MM');
    const ini = dayjs(mes + '-01');
    const fin = ini.endOf('month');

    // KPIs simples
    const [[kpis]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM unidades) AS unidades,
        (SELECT COUNT(*) FROM mantenimientos WHERE fecha_fin IS NULL) AS en_taller,
        (SELECT COUNT(*) FROM mantenimientos WHERE DATE(fecha_inicio)=CURDATE()) AS hoy
    `);

    // últimos 10 del rango del mes
    const [mants] = await pool.query(
      `
      SELECT m.id, u.placa, c.nombre AS cedis, m.tipo, m.fecha_inicio, m.fecha_fin, m.duracion_dias
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       WHERE (m.fecha_inicio BETWEEN ? AND ?)
          OR (m.fecha_fin BETWEEN ? AND ?)
       ORDER BY m.id DESC
       LIMIT 10
    `,
      [ini.format('YYYY-MM-DD'), fin.format('YYYY-MM-DD'), ini.format('YYYY-MM-DD'), fin.format('YYYY-MM-DD')]
    );

    res.render('dashboard', { title: 'Dashboard', kpis, mants, mes });
  } catch (e) {
    console.error('dashboard error', e);
    res.status(500).render('error', { title: 'Error', message: 'Error cargando dashboard' });
  }
});

/* ===========================
   Unidades (lista + programar por unidad/cede)
=========================== */
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedisId || '';
    const where = [];
    const params = [];

    if (cedisId) {
      where.push('u.cedis_id = ?');
      params.push(cedisId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [unidades] = await pool.query(
      `
      SELECT u.*, c.nombre AS cedis_nombre
        FROM unidades u
        LEFT JOIN cedis c ON c.id = u.cedis_id
       ${whereSql}
       ORDER BY u.id DESC
    `,
      params
    );

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('unidades', {
      title: 'Unidades',
      unidades,
      cedis,
      cedisId,
    });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo cargar unidades' });
  }
});

// Programar un mantenimiento preventivo para UNA unidad
app.post('/unidades/:id/programar', async (req, res) => {
  const unidadId = Number(req.params.id);
  try {
    const [[u]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!u) return res.status(404).send('Unidad no encontrada');

    const fecha = await calcularProximaFecha(unidadId);

    await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
    `,
      [unidadId, u.cedis_id || null, fecha, u.kilometraje || null, req.session.user?.id || null]
    );

    const mesRedir = dayjs(fecha).format('YYYY-MM');
    res.redirect(`/mantenimientos?mes=${mesRedir}${u.cedis_id ? `&cedisId=${u.cedis_id}` : ''}`);
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo programar la unidad' });
  }
});

// Programar TODAS las unidades de una CEDE (preventivo)
app.post('/unidades/programar-cede', async (req, res) => {
  const cedisId = Number(req.body.cedis_id);
  if (!cedisId) return res.status(400).send('cedis_id requerido');
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const [unidades] = await conn.query('SELECT * FROM unidades WHERE cedis_id=?', [cedisId]);
    for (const u of unidades) {
      const fecha = await calcularProximaFecha(u.id);
      await conn.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [u.id, cedisId, fecha, u.kilometraje || null, req.session.user?.id || null]
      );
    }
    await conn.commit();
    const mesRedir = dayjs().format('YYYY-MM');
    res.redirect(`/mantenimientos?mes=${mesRedir}&cedisId=${cedisId}`);
  } catch (e) {
    await conn.rollback();
    console.error('programar cede error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo programar por cede' });
  } finally {
    conn.release();
  }
});

/* ===========================
   Mantenimientos (abiertos) + historial
=========================== */
// Abiertos con filtros: mes (obligatorio por defecto), cede, placa
app.get('/mantenimientos', async (req, res) => {
  try {
    const mes = req.query.mes || dayjs().format('YYYY-MM');
    const placa = (req.query.placa || '').trim().toUpperCase();
    const cedisId = req.query.cedisId || '';

    const ini = dayjs(mes + '-01');
    const finMesNatural = ini.endOf('month');
    const tope = dayjs().add(30, 'day');
    const fin = finMesNatural.isAfter(tope, 'day') ? tope : finMesNatural; // opcional: recortar a 30 días

    const where = [`m.fecha_fin IS NULL`, `m.fecha_inicio BETWEEN ? AND ?`];
    const params = [ini.format('YYYY-MM-DD'), fin.format('YYYY-MM-DD')];

    if (cedisId) {
      where.push('m.cedis_id = ?');
      params.push(cedisId);
    }
    if (placa) {
      where.push('u.placa LIKE ?');
      params.push(`%${placa}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [abiertos] = await pool.query(
      `
      SELECT m.*, u.placa, c.nombre AS cedis_nombre
        FROM mantenimientos m
        JOIN unidades u ON u.id = m.unidad_id
        LEFT JOIN cedis c ON c.id = m.cedis_id
       ${whereSql}
       ORDER BY m.fecha_inicio ASC, m.id ASC
    `,
      params
    );

    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    res.render('mantenimientos_list', {
      title: 'Mantenimientos abiertos',
      mants: abiertos,
      cedis,
      cedisId,
      mes,
      placa,
    });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo listar mantenimientos' });
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
    res.status(500).render('error', { title: 'Error', message: 'No se pudo cargar historial' });
  }
});

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
    res.status(500).render('error', { title: 'Error', message: 'No se pudo cargar historial por placa' });
  }
});

/* ===========================
   Cerrar + reprogramar (tope 30 días) + eliminar
=========================== */
// Cerrar y reprogramar (form “Se realizó” manda trabajos[] y comentario)
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  const mantId = Number(req.params.id);
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const [[mant]] = await conn.query('SELECT * FROM mantenimientos WHERE id=? FOR UPDATE', [mantId]);
    if (!mant) {
      await conn.rollback();
      return res.status(404).send('Mantenimiento no encontrado');
    }

    const hoy = dayjs().format('YYYY-MM-DD');
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();
    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // NO tocar duracion_dias si es generada
    await conn.query(
      `
      UPDATE mantenimientos
         SET fecha_fin=?,
             reservado_inventario=0,
             motivo = CONCAT(COALESCE(motivo,''), ?, ?)
       WHERE id=?
    `,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    // Liberar unidad si no quedan abiertos
    const [[urow]] = await conn.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    const unidadId = urow?.unidad_id || mant.unidad_id;
    if (unidadId) {
      const [[ab]] = await conn.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [unidadId]
      );
      if (Number(ab?.abiertos || 0) === 0) {
        await conn.query("UPDATE unidades SET estado='ACTIVA' WHERE id=?", [unidadId]);
      }
    }

    // Reprogramar preventivo con tope 30 días
    let fechaProgramada = null;
    if (unidadId) {
      fechaProgramada = await calcularProximaFecha(unidadId, mant.cedis_id || null);
      await conn.query(
        `
        INSERT INTO mantenimientos
          (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
        VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
      `,
        [
          unidadId,
          mant.cedis_id || null,
          fechaProgramada,
          mant.km_al_entrar || null,
          req.session.user?.id || null,
        ]
      );
    }

    await conn.commit();
    const mesRedir = fechaProgramada
      ? dayjs(fechaProgramada).format('YYYY-MM')
      : dayjs().format('YYYY-MM');
    const sedeRedir = mant.cedis_id ? `&cedisId=${mant.cedis_id}` : '';
    return res.redirect(`/mantenimientos?mes=${mesRedir}${sedeRedir}`);
  } catch (e) {
    await conn.rollback();
    console.error('cerrar/reprogramar error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo cerrar y reprogramar' });
  } finally {
    conn.release();
  }
});

// Eliminar mantenimiento (POST/DELETE)
app.post('/mantenimientos/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [id]);
    const back = req.header('Referer') || '/mantenimientos';
    res.redirect(back);
  } catch (e) {
    console.error('delete mant error', e);
    res.status(500).render('error', { title: 'Error', message: 'No se pudo eliminar' });
  }
});

/* ===========================
   API IA programar (unidad/placa)
=========================== */
app.post('/api/ia/programar', async (req, res) => {
  try {
    const { unidad_id, placa } = req.body || {};
    if (!unidad_id && !placa) return res.status(400).json({ error: 'unidad_id o placa requerido' });

    let unidad = null;
    if (unidad_id) {
      const [u1] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidad_id]);
      unidad = u1?.[0] || null;
    } else if (placa) {
      const [u2] = await pool.query('SELECT * FROM unidades WHERE placa=?', [placa.trim().toUpperCase()]);
      unidad = u2?.[0] || null;
    }
    if (!unidad) return res.status(404).json({ error: 'Unidad no encontrada' });

    const fecha = await calcularProximaFecha(unidad.id);
    const [r] = await pool.query(
      `
      INSERT INTO mantenimientos
        (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
      VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)
    `,
      [unidad.id, unidad.cedis_id || null, fecha, unidad.kilometraje || null, null]
    );

    res.json({ ok: true, id: r.insertId, fecha_programada: fecha });
  } catch (e) {
    console.error('api/ia/programar error', e);
    res.status(500).json({ error: 'No se pudo programar' });
  }
});

/* ===========================
   Diagnóstico
=========================== */
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

/* ===========================
   Arranque
=========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
