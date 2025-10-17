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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ====== Motor de vistas y middlewares ======
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/layout'); // No uses <% layout() %> en las vistas

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
  next();
});

// ================= IA REGLAS (21–35 días), sin domingos, separación >=7 días =================
function diasBasePorVeces(veces = 0) {
  if (veces >= 5) return 24;
  if (veces >= 3) return 28;
  return 30;
}
function ajustePorTrabajo(trabajos = []) {
  const t = (trabajos || []).map((s) => String(s || '').toLowerCase());
  if (t.some((x) => x.includes('aceite') || x.includes('filtro'))) return 30;
  if (t.some((x) => x.includes('fren'))) return 28;
  if (t.some((x) => x.includes('llanta') || x.includes('neum'))) return 35;
  if (t.some((x) => x.includes('correa') || x.includes('banda'))) return 35;
  return 30;
}
function esDomingo(iso) {
  return dayjs(iso).day() === 0;
}
function siguienteHabil(iso) {
  let d = dayjs(iso);
  while (d.day() === 0) d = d.add(1, 'day');
  return d;
}
async function obtenerFechasProgramadas() {
  const [rows] = await pool.query(`
    SELECT fecha_inicio FROM mantenimientos
    WHERE fecha_fin IS NULL AND fecha_inicio IS NOT NULL
  `);
  return new Set(
    (rows || []).map((r) => dayjs(r.fecha_inicio).format('YYYY-MM-DD'))
  );
}
function espaciar7dias(fechaISO, setFechas) {
  let f = dayjs(fechaISO);
  const colisiona = (cand) => {
    const c = dayjs(cand);
    for (const val of setFechas) {
      if (Math.abs(c.diff(dayjs(val), 'day')) < 7) return true;
    }
    return false;
  };
  while (esDomingo(f) || colisiona(f)) f = f.add(1, 'day');
  return f;
}
async function calcularProximaFecha(unidadId, trabajosHechos = []) {
  const [[{ veces } = { veces: 0 }]] = await pool.query(
    'SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?',
    [unidadId]
  );

  const [hist] = await pool.query(
    `SELECT id, tipo, fecha_inicio, fecha_fin
     FROM mantenimientos
     WHERE unidad_id=?
     ORDER BY id DESC LIMIT 1`,
    [unidadId]
  );
  const ultimo = Array.isArray(hist) && hist.length ? hist[0] : null;

  let dias = Math.min(35, Math.max(21, diasBasePorVeces(veces || 0)));
  const adj = ajustePorTrabajo(trabajosHechos);
  dias = Math.min(35, Math.max(21, Math.round((dias + adj) / 2)));

  if (ultimo && String(ultimo.tipo || '').toUpperCase() === 'CORRECTIVO') {
    dias = Math.min(dias, 28);
    dias = Math.max(dias, 21);
  }

  const base = ultimo ? ultimo.fecha_fin || ultimo.fecha_inicio : dayjs().format('YYYY-MM-DD');
  let sugerida = dayjs(base).add(dias, 'day');
  sugerida = siguienteHabil(sugerida);

  const setFechas = await obtenerFechasProgramadas();
  sugerida = espaciar7dias(sugerida, setFechas);

  return sugerida.format('YYYY-MM-DD');
}

// ================= Auth mínimo =================
app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.password_hash, r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON r.id=u.rol_id
        WHERE u.username=? AND u.activo=1`,
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

// ================= Dashboard =================
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
      ORDER BY m.id DESC LIMIT 10
    `);
    res.render('dashboard', { title: 'Dashboard', kpis, mants });
  } catch (e) {
    console.error('dashboard error', e);
    res.status(500).send('Error cargando dashboard');
  }
});

// ================= Unidades (lista + filtro + programar cede) =================
app.get('/unidades', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id ? String(req.query.cedis_id) : '';
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let unidades = [];
    if (cedisId) {
      [unidades] = await pool.query(
        `SELECT u.*, c.nombre AS cedis_nombre
           FROM unidades u
           LEFT JOIN cedis c ON c.id=u.cedis_id
          WHERE u.cedis_id=?
          ORDER BY u.placa ASC`,
        [cedisId]
      );
    } else {
      [unidades] = await pool.query(
        `SELECT u.*, c.nombre AS cedis_nombre
           FROM unidades u
           LEFT JOIN cedis c ON c.id=u.cedis_id
          ORDER BY u.placa ASC`
      );
    }

    res.render('unidades', { title: 'Unidades', unidades, cedis, cedisId });
  } catch (e) {
    console.error('unidades list error', e);
    res.status(500).send('No se pudo cargar unidades');
  }
});

// Programar TODA una cede (POST) — acepta cedis_id | cede_id | cede
app.post('/unidades/programar-cede', async (req, res) => {
  try {
    const cedisId = Number(req.body.cedis_id || req.body.cede_id || req.body.cede);
    if (!cedisId) return res.status(400).send('cedis_id requerido');

    const [unidades] = await pool.query(
      'SELECT * FROM unidades WHERE cedis_id=? ORDER BY placa',
      [cedisId]
    );

    let offsetDias = 0;
    for (const u of unidades || []) {
      const fechaBase = await calcularProximaFecha(u.id, []);
      const fecha = dayjs(fechaBase).add(offsetDias, 'day').format('YYYY-MM-DD');
      await pool.query(
        `INSERT INTO mantenimientos
           (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
        [u.id, u.cedis_id || null, fecha, u.kilometraje || null, req.session.user?.id || null]
      );
      offsetDias = (offsetDias + 1) % 7; // escalona sutil
    }

    res.redirect('/mantenimientos?cedis_id=' + cedisId);
  } catch (e) {
    console.error('programar cede error', e);
    res.status(500).send('No se pudo programar la cede');
  }
});

// Programar una unidad puntual (POST)
app.post('/unidades/:id/programar', async (req, res) => {
  try {
    const unidadId = Number(req.params.id);
    const [[u]] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    if (!u) return res.status(404).send('Unidad no encontrada');

    const fecha = await calcularProximaFecha(unidadId, []);
    await pool.query(
      `INSERT INTO mantenimientos
         (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
       VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
      [unidadId, u.cedis_id || null, fecha, u.kilometraje || null, req.session.user?.id || null]
    );
    const back = req.query.cedis_id ? `/unidades?cedis_id=${req.query.cedis_id}` : '/unidades';
    res.redirect(back);
  } catch (e) {
    console.error('programar unidad error', e);
    res.status(500).send('No se pudo programar la unidad');
  }
});

// ================= Mantenimientos: abiertos (con filtro por cede) =================
app.get('/mantenimientos', async (req, res) => {
  try {
    const cedisId = req.query.cedis_id ? String(req.query.cedis_id) : '';
    const [cedis] = await pool.query('SELECT * FROM cedis ORDER BY nombre');

    let abiertos = [];
    if (cedisId) {
      [abiertos] = await pool.query(
        `SELECT m.*, u.placa, c.nombre AS cedis_nombre
         FROM mantenimientos m
         JOIN unidades u ON u.id=m.unidad_id
         LEFT JOIN cedis c ON c.id=m.cedis_id
         WHERE m.fecha_fin IS NULL AND u.cedis_id=?
         ORDER BY m.id DESC`,
        [cedisId]
      );
    } else {
      [abiertos] = await pool.query(
        `SELECT m.*, u.placa, c.nombre AS cedis_nombre
         FROM mantenimientos m
         JOIN unidades u ON u.id=m.unidad_id
         LEFT JOIN cedis c ON c.id=m.cedis_id
         WHERE m.fecha_fin IS NULL
         ORDER BY m.id DESC`
      );
    }

    res.render('mantenimientos_list', { title: 'Mantenimientos', mants: abiertos, cedis, cedisId });
  } catch (e) {
    console.error('mants abiertos error', e);
    res.status(500).send('No se pudo listar mantenimientos');
  }
});

// Historial global
app.get('/historial', async (req, res) => {
  try {
    const [cerrados] = await pool.query(
      `SELECT m.*, u.placa, c.nombre AS cedis_nombre
       FROM mantenimientos m
       JOIN unidades u ON u.id=m.unidad_id
       LEFT JOIN cedis c ON c.id=m.cedis_id
       WHERE m.fecha_fin IS NOT NULL
       ORDER BY m.fecha_fin DESC, m.id DESC`
    );
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
      `SELECT m.*, u.placa, c.nombre AS cedis_nombre
       FROM mantenimientos m
       JOIN unidades u ON u.id=m.unidad_id
       LEFT JOIN cedis c ON c.id=m.cedis_id
       WHERE u.placa=?
       ORDER BY m.id DESC`,
      [placa]
    );
    res.render('historial_placa', { title: `Historial ${placa}`, mants: rows, placa });
  } catch (e) {
    console.error('historial placa error', e);
    res.status(500).send('No se pudo cargar historial por placa');
  }
});

// Cerrar y reprogramar (21–35 días, evita domingos y colisiones < 7d)
app.post('/mantenimientos/:id/realizado', async (req, res) => {
  try {
    const mantId = Number(req.params.id);
    const [[mant]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
    if (!mant) return res.status(404).send('Mantenimiento no encontrado');

    const hoy = dayjs().format('YYYY-MM-DD');
    const trabajos = (Array.isArray(req.body.trabajos) ? req.body.trabajos : []).filter(Boolean);
    const comentario = (req.body.comentario || '').trim();

    const hechoTxt = trabajos.length ? ` | Hecho: ${trabajos.join(', ')}` : '';
    const comentarioTxt = comentario ? ` | Nota: ${comentario}` : '';

    // No tocar duracion_dias si es columna generada
    await pool.query(
      `UPDATE mantenimientos
          SET fecha_fin=?, reservado_inventario=0,
              motivo = CONCAT(COALESCE(motivo,''), ?, ?)
        WHERE id=?`,
      [hoy, hechoTxt, comentarioTxt, mantId]
    );

    const [[rowU]] = await pool.query('SELECT unidad_id FROM mantenimientos WHERE id=?', [mantId]);
    const unidadId = rowU?.unidad_id;

    if (unidadId) {
      // Liberar unidad si no hay abiertos
      const [[ab]] = await pool.query(
        'SELECT COUNT(*) AS abiertos FROM mantenimientos WHERE unidad_id=? AND fecha_fin IS NULL',
        [unidadId]
      );
      if ((ab?.abiertos || 0) === 0) {
        await pool.query(`UPDATE unidades SET estado='ACTIVA' WHERE id=?`, [unidadId]);
      }

      // Próxima fecha (ajustada por trabajos realizados)
      const fecha = await calcularProximaFecha(unidadId, trabajos);

      await pool.query(
        `INSERT INTO mantenimientos
           (unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, reservado_inventario, creado_por)
         VALUES (?,?, 'PREVENTIVO', 'Plan preventivo sugerido', ?, ?, 1, ?)`,
        [unidadId, mant.cedis_id || null, fecha, mant.km_al_entrar || null, req.session.user?.id || null]
      );
    }

    const back = req.query.cedis_id ? `/mantenimientos?cedis_id=${req.query.cedis_id}` : '/mantenimientos';
    res.redirect(back);
  } catch (e) {
    console.error('cerrar/reprogramar error', e);
    res.status(500).send('No se pudo cerrar y reprogramar');
  }
});

// Eliminar mantenimiento (por si lo necesitas)
app.post('/mantenimientos/:id/delete', async (req, res) => {
  try {
    const mantId = Number(req.params.id);
    await pool.query('DELETE FROM mantenimientos WHERE id=?', [mantId]);
    const back = req.query.cedis_id ? `/mantenimientos?cedis_id=${req.query.cedis_id}` : '/mantenimientos';
    res.redirect(back);
  } catch (e) {
    console.error('delete mantenimiento error', e);
    res.status(500).send('No se pudo eliminar');
  }
});

// ================= Diagnóstico =================
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ================= Start =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor en http://0.0.0.0:${PORT}`);
});
