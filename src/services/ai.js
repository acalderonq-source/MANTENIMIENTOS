// src/services/ai.js
import OpenAI from 'openai';
import dayjs from 'dayjs';

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5'; // puedes usar gpt-5-mini si quieres ahorro

// Helper: llamada segura a Responses API devolviendo JSON
async function callJSON(system, user, schema) {
  if (!client) {
    // Fallback determinista sin IA
    return { tipo: 'PREVENTIVO', motivo_sugerido: user?.motivo || 'Mantenimiento preventivo', tareas: ['Cambio de aceite'], dias_intervalo: 45, comentario: 'Regla por defecto (sin API).' };
  }
  const resp = await client.responses.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    input: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) }
    ]
  });
  // Responses API: tomar el primer output_text
  const item = resp.output?.[0];
  const text = item?.content?.[0]?.text || item?.content?.[0]?.string_value || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  // sanea contra el schema básico
  return {
    tipo: String(parsed.tipo || 'PREVENTIVO').toUpperCase(),
    motivo_sugerido: parsed.motivo_sugerido || user?.motivo || 'Mantenimiento preventivo',
    tareas: Array.isArray(parsed.tareas) ? parsed.tareas : ['Inspección general'],
    dias_intervalo: Number(parsed.dias_intervalo || 45),
    comentario: parsed.comentario || 'Generado por IA.'
  };
}

// === Export 1: Clasificar motivo / sugerir plan corto
export async function aiClassify({ motivo, placa, km, cedis }) {
  const system = `Eres un planificador de mantenimiento preventivo para flota. 
Devuelve JSON con: tipo ('PREVENTIVO' o 'CORRECTIVO'), motivo_sugerido (string), tareas (array corta 3-6), dias_intervalo (int), comentario. 
Asume enfoque SOLO PREVENTIVO salvo que motivo sugiera avería crítica.`;
  const user = { motivo, placa, km, cedis };
  return callJSON(system, user);
}

// === Export 2: Resumen de mantenimiento por id
export async function aiSummarize({ pool, mantId }) {
  const [[m]] = await pool.query('SELECT * FROM mantenimientos WHERE id=?', [mantId]);
  if (!m) return { resumen: 'Sin datos' };
  const system = `Eres un asistente técnico. Resume el mantenimiento en 3 viñetas claras (máx 50 palabras).`;
  const user = {
    id: m.id,
    tipo: m.tipo,
    motivo: m.motivo,
    fecha_inicio: m.fecha_inicio,
    fecha_fin: m.fecha_fin,
    km_al_entrar: m.km_al_entrar
  };
  if (!client) {
    return { resumen: `• ${m.tipo}: ${m.motivo}\n• Inicio: ${m.fecha_inicio} Fin: ${m.fecha_fin || 'abierto'}\n• KM: ${m.km_al_entrar ?? 'N/D'}` };
  }
  const resp = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) }
    ]
  });
  const txt = resp.output?.[0]?.content?.[0]?.text || 'Resumen no disponible.';
  return { resumen: txt };
}

// === Export 3: Sugerir próxima fecha por placa (reglas + IA mínima)
export async function aiSuggestNext({ pool, placa }) {
  // último mantenimiento por placa
  const [rows] = await pool.query(
    `SELECT m.* FROM mantenimientos m
     JOIN unidades u ON u.id=m.unidad_id
     WHERE u.placa=? ORDER BY m.id DESC LIMIT 1`, [placa]);
  const ultimo = Array.isArray(rows) && rows[0] ? rows[0] : null;

  let base = dayjs();
  let dias = 45;
  if (ultimo) {
    base = dayjs(ultimo.fecha_fin || ultimo.fecha_inicio);
    // micro-ajuste: correctivo ⇒ más pronto
    if (String(ultimo.tipo).toUpperCase()==='CORRECTIVO') dias = 30;
  }
  const propuesta = base.add(dias, 'day').format('YYYY-MM-DD');
  return { proxima_fecha: propuesta, explicacion: `Base ${dias} días desde ${ultimo ? (ultimo.fecha_fin || ultimo.fecha_inicio) : 'hoy'}.` };
}

// === Export 4: Plan preventivo integral (tareas + intervalo)
export async function aiPreventivePlan({ pool, unidadId, placa }) {
  // veces que ha entrado y último
  let u = null;
  if (unidadId) {
    const [uu] = await pool.query('SELECT * FROM unidades WHERE id=?', [unidadId]);
    u = uu?.[0] || null;
  } else if (placa) {
    const [uu] = await pool.query('SELECT * FROM unidades WHERE placa=?', [placa]);
    u = uu?.[0] || null;
  }
  if (!u) return { tareas: ['Inspección general'], dias_intervalo: 45, motivo_sugerido: 'Plan preventivo', fecha_sugerida: dayjs().add(45,'day').format('YYYY-MM-DD') };

  const [[v]] = await pool.query('SELECT COUNT(*) AS veces FROM mantenimientos WHERE unidad_id=?', [u.id]);
  const veces = Number(v?.veces || 0);
  let dias_base = 45; if (veces >= 5) dias_base = 35; else if (veces >= 3) dias_base = 40;

  const [hist] = await pool.query(
    `SELECT id, tipo, fecha_inicio, fecha_fin
       FROM mantenimientos
      WHERE unidad_id=?
      ORDER BY id DESC
      LIMIT 1`, [u.id]);
  const ultimo = Array.isArray(hist) && hist[0] ? hist[0] : null;
  if (ultimo && String(ultimo.tipo).toUpperCase()==='CORRECTIVO') dias_base = Math.min(dias_base, 30);

  const cls = await aiClassify({ motivo: 'Plan preventivo sugerido', placa: u.placa, km: u.kilometraje, cedis: u.cedis_id });
  const base = dayjs(ultimo ? (ultimo.fecha_fin || ultimo.fecha_inicio) : dayjs());
  const fecha = base.add(cls.dias_intervalo || dias_base, 'day').format('YYYY-MM-DD');

  return {
    tareas: cls.tareas,
    dias_intervalo: cls.dias_intervalo || dias_base,
    motivo_sugerido: cls.motivo_sugerido || 'Plan preventivo',
    comentario: cls.comentario,
    fecha_sugerida: fecha
  };
}
