// src/db_memory.js
import dayjs from 'dayjs';

let auto = { cedis: 3, unidades: 4, mantenimientos: 4 };

const cedis = [
  { id: 1, nombre: 'CEDIS Centro' },
  { id: 2, nombre: 'CEDIS Norte'  },
  { id: 3, nombre: 'CEDIS Sur'    },
];

const unidades = [
  { id: 1, placa: 'C167062', tipo: 'CAMION', cedis_id: 1, kilometraje: 120000, estado: 'ACTIVA' },
  { id: 2, placa: 'C167063', tipo: 'CAMION', cedis_id: 2, kilometraje:  95000, estado: 'ACTIVA' },
  { id: 3, placa: 'C167064', tipo: 'VAN',    cedis_id: 2, kilometraje:  40000, estado: 'ACTIVA' },
  { id: 4, placa: 'C167065', tipo: 'AUTO',   cedis_id: 3, kilometraje:  15000, estado: 'ACTIVA' },
];

const mantenimientos = [
  { id: 1, unidad_id: 1, cedis_id: 1, tipo: 'PREVENTIVO', motivo: 'Prev: Cambio de aceite', fecha_inicio: dayjs().subtract(50,'day').format('YYYY-MM-DD'), fecha_fin: dayjs().subtract(49,'day').format('YYYY-MM-DD'), km_al_entrar: 118000, duracion_dias: 1, reservado_inventario: 0, creado_por: 1 },
  { id: 2, unidad_id: 2, cedis_id: 2, tipo: 'CORRECTIVO', motivo: 'Frenos',                 fecha_inicio: dayjs().subtract(20,'day').format('YYYY-MM-DD'), fecha_fin: dayjs().subtract(18,'day').format('YYYY-MM-DD'), km_al_entrar:  94000, duracion_dias: 2, reservado_inventario: 0, creado_por: 1 },
  { id: 3, unidad_id: 3, cedis_id: 2, tipo: 'PREVENTIVO', motivo: 'Prev: Inspección',       fecha_inicio: dayjs().subtract(10,'day').format('YYYY-MM-DD'), fecha_fin: null,                                         km_al_entrar:  39500, duracion_dias: null, reservado_inventario: 1, creado_por: 1 },
  { id: 4, unidad_id: 1, cedis_id: 1, tipo: 'PREVENTIVO', motivo: 'Prev: Filtros',          fecha_inicio: dayjs().add(5,'day').format('YYYY-MM-DD'),       fecha_fin: null,                                         km_al_entrar: 120500, duracion_dias: null, reservado_inventario: 1, creado_por: 1 },
];

function toCount(n){ return [{ [`COUNT(*)`]: n, count: n, veces: n }]; }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function norm(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); }

function getUnidadById(id){ return unidades.find(u=>u.id===Number(id)) || null; }
function getUnidadByPlaca(placa){ return unidades.find(u=>u.placa===placa) || null; }
function lastMantByUnidadId(uid){
  return clone(mantenimientos.filter(m=>m.unidad_id===Number(uid)).sort((a,b)=>b.id-a.id).slice(0,1));
}

export const pool = {
  async query(sql, params = []) {
    const q = norm(sql);
// ¿Fecha tomada? -> SELECT COUNT(*) ... WHERE fecha_fin IS NULL AND fecha_inicio=?
if (
  q.startsWith('select count(*) as n from mantenimientos where fecha_fin is null and fecha_inicio=?') ||
  q.startsWith('select count(*) from mantenimientos where fecha_fin is null and fecha_inicio=?')
) {
  const dateStr = params[0];
  const n = mantenimientos.filter(m => !m.fecha_fin && m.fecha_inicio === dateStr).length;
  return [[{ n, count: n }]];
}
// Soporte: traer todas las fechas agendadas (abiertos/futuros)
if (
  q.startsWith('select fecha_inicio from mantenimientos where fecha_fin is null and fecha_inicio is not null')
) {
  // Filtra mantenimientos abiertos con fecha definida
  const rows = mantenimientos
    .filter(m => !m.fecha_fin && m.fecha_inicio)
    .map(m => ({ fecha_inicio: m.fecha_inicio }));
  return [rows];
}

    // KPIs
    if (q === 'select count(*) from unidades') return [toCount(unidades.length)];
    if (q.includes('select count(*) from mantenimientos where fecha_fin is null')) {
      return [toCount(mantenimientos.filter(m=>!m.fecha_fin).length)];
    }
    if (q.includes('select count(*) from mantenimientos where date(fecha_inicio)=curdate()')) {
      const today = dayjs().format('YYYY-MM-DD');
      return [toCount(mantenimientos.filter(m=>m.fecha_inicio===today).length)];
    }

    // Últimos 10 (dashboard)
    if (q.startsWith('select m.id, u.placa, c.nombre as cedis, m.tipo')) {
      const rows = clone(mantenimientos)
        .sort((a,b)=>b.id-a.id)
        .slice(0,10)
        .map(m=>{
          const u = getUnidadById(m.unidad_id);
          const c = cedis.find(c=>c.id===(m.cedis_id||u?.cedis_id));
          return { id:m.id, placa:u?.placa||null, cedis:c?.nombre||null, tipo:m.tipo, fecha_inicio:m.fecha_inicio, fecha_fin:m.fecha_fin, duracion_dias:m.duracion_dias??null };
        });
      return [rows];
    }

    // Lista mantenimientos
    if (q.startsWith('select m.*, u.placa, u.id as unidad_id, c.nombre as cedis_nombre')) {
      const rows = clone(mantenimientos)
        .sort((a,b)=>b.id-a.id)
        .map(m=>{
          const u = getUnidadById(m.unidad_id);
          const c = cedis.find(c=>c.id===(m.cedis_id||u?.cedis_id));
          return { ...m, unidad_id: m.unidad_id, placa: u?.placa || null, cedis_nombre: c?.nombre || null };
        });
      return [rows];
    }

    // Historial cerrados
    if (q.startsWith('select m.*, u.placa, c.nombre as cedis_nombre from mantenimientos m join unidades u on u.id=m.unidad_id left join cedis c on c.id=m.cedis_id where m.fecha_fin is not null')) {
      const rows = clone(mantenimientos)
        .filter(m=>m.fecha_fin)
        .sort((a,b)=>b.id-a.id)
        .map(m=>{
          const u = getUnidadById(m.unidad_id);
          const c = cedis.find(c=>c.id===(m.cedis_id||u?.cedis_id));
          return { ...m, placa: u?.placa || null, cedis_nombre: c?.nombre || null };
        });
      return [rows];
    }

    // Unidades + variantes
    if (q.startsWith('select * from unidades where id=?')) {
      const id = Number(params[0]); return [clone(unidades.filter(u=>u.id===id))];
    }
    if (q.startsWith('select * from unidades where placa=?')) {
      const placa = params[0]; return [clone(unidades.filter(u=>u.placa===placa))];
    }
    if (q.startsWith('select id, cedis_id, kilometraje from unidades where id=?')) {
      const id = Number(params[0]); const u=getUnidadById(id); return [[u?{id:u.id, cedis_id:u.cedis_id, kilometraje:u.kilometraje}:undefined].filter(Boolean)];
    }
    if (q.startsWith("select * from unidades where estado!='inactiva' order by placa")) {
      return [clone(unidades.filter(u=>u.estado!=='INACTIVA').sort((a,b)=>String(a.placa).localeCompare(b.placa)))];
    }
    if (q.startsWith('select u.*, c.nombre as cedis_nombre from unidades u left join cedis c on c.id=u.cedis_id order by u.id desc')) {
      const rows = clone(unidades).sort((a,b)=>b.id-a.id).map(u=>{
        const c = cedis.find(c=>c.id===u.cedis_id);
        return {...u, cedis_nombre: c?.nombre || null};
      });
      return [rows];
    }

    // CEDIS
    if (q.startsWith('select * from cedis order by nombre')) {
      return [clone(cedis).sort((a,b)=>String(a.nombre).localeCompare(b.nombre))];
    }
    if (q.startsWith('select * from cedis')) return [clone(cedis)];

    // INSERT/UPDATE unidades
    if (q.startsWith('insert into unidades')) {
      const [placa, tipo, cedis_id, kilometraje] = params;
      unidades.push({ id: ++auto.unidades, placa, tipo, cedis_id: cedis_id?Number(cedis_id):null, kilometraje:Number(kilometraje||0), estado:'ACTIVA' });
      return [{ insertId: auto.unidades }];
    }
    if (q.startsWith("update unidades set estado='inactiva' where id=?")) { const id=Number(params[0]); const u=getUnidadById(id); if(u) u.estado='INACTIVA'; return [{}]; }
    if (q.startsWith("update unidades set estado='en_taller' where id=?")) { const id=Number(params[0]); const u=getUnidadById(id); if(u) u.estado='EN_TALLER'; return [{}]; }
    if (q.startsWith("update unidades set estado='activa' where id=?")) { const id=Number(params[0]); const u=getUnidadById(id); if(u) u.estado='ACTIVA'; return [{}]; }

    // INSERT mantenimientos (directo)
    if (q.startsWith('insert into mantenimientos (unidad_id')) {
      const [unidad_id, cedis_id, tipo, motivo, fecha_inicio, km_al_entrar, creado_por] = params;
      const u = getUnidadById(unidad_id);
      if (!u) return [{ insertId: 0 }];
      const row = { id: ++auto.mantenimientos, unidad_id:Number(unidad_id), cedis_id: cedis_id?Number(cedis_id):(u?.cedis_id||null), tipo, motivo, fecha_inicio, fecha_fin: null, km_al_entrar: km_al_entrar?Number(km_al_entrar):null, duracion_dias: null, reservado_inventario: 1, creado_por: creado_por||null };
      mantenimientos.push(row);
      return [{ insertId: row.id }];
    }

    // INSERT reprogramación (select de unidad)
    if (q.startsWith('insert into mantenimientos') && q.includes('select u.id, u.cedis_id')) {
      const [motivo, fecha, creado_por, unidad_id] = params;
      const u = getUnidadById(unidad_id);
      if (!u) return [{ insertId: 0 }];
      const row = { id: ++auto.mantenimientos, unidad_id: u.id, cedis_id: u.cedis_id, tipo: 'PREVENTIVO', motivo, fecha_inicio: fecha, fecha_fin: null, km_al_entrar: u.kilometraje||null, duracion_dias:null, reservado_inventario:1, creado_por: creado_por||null };
      mantenimientos.push(row);
      return [{ insertId: row.id }];
    }

    // UPDATE cerrar
    if (q.startsWith('update mantenimientos') && q.includes('set fecha_fin=?')) {
      const [fecha_fin, ref, id] = params;
      const m = mantenimientos.find(m=>m.id===Number(id));
      if (m) {
        m.fecha_fin = fecha_fin;
        const start = dayjs(m.fecha_inicio);
        m.duracion_dias = Math.max(0, dayjs(ref).diff(start,'day'));
        m.reservado_inventario = 0;
      }
      return [{}];
    }

    // Auxiliares
    if (q.startsWith('select unidad_id from mantenimientos where id=?')) {
      const id = Number(params[0]); const m = mantenimientos.find(m=>m.id===id);
      return [[{ unidad_id: m?.unidad_id || null }]];
    }
    if (q.startsWith('select count(*) as abiertos from mantenimientos where unidad_id=? and fecha_fin is null')) {
      const uid = Number(params[0]); const n = mantenimientos.filter(m=>m.unidad_id===uid && !m.fecha_fin).length;
      return [[{ abiertos: n }]];
    }
    // NUEVOS
    if (q.startsWith('select count(*) as veces from mantenimientos where unidad_id=?')) {
      const uid = Number(params[0]); const n = mantenimientos.filter(m=>m.unidad_id===uid).length;
      return [[{ veces: n }]];
    }
    if (q.startsWith('select id, tipo, fecha_inicio, fecha_fin from mantenimientos where unidad_id=? order by id desc limit 1')) {
      const uid = Number(params[0]); return [ lastMantByUnidadId(uid) ];
    }
    if (q.startsWith('select id, fecha_inicio, fecha_fin from mantenimientos where unidad_id=? order by id desc limit 1')) {
      const uid = Number(params[0]);
      const rows = lastMantByUnidadId(uid).map(m=>({ id:m.id, fecha_inicio:m.fecha_inicio, fecha_fin:m.fecha_fin }));
      return [rows];
    }
    if (q.startsWith('select m.* from mantenimientos m join unidades u on u.id=m.unidad_id where u.placa=? order by m.id desc limit 1')) {
      const placa = params[0]; const u = getUnidadByPlaca(placa); if (!u) return [[]];
      return [ lastMantByUnidadId(u.id) ];
    }
    if (q.startsWith('select id from unidades where placa=?')) {
      const placa = params[0]; const u = getUnidadByPlaca(placa);
      return [[ u ? { id: u.id } : undefined ].filter(Boolean)];
    }

    // comodines
    if (q.startsWith('select * from cedis')) return [clone(cedis)];
    if (q.startsWith('select * from unidades')) return [clone(unidades)];
    if (q.startsWith('select * from mantenimientos where id=?')) {
      const id = Number(params[0]); return [clone(mantenimientos.filter(m=>m.id===id))];
    }

    // delete
    if (q.startsWith('delete from mantenimientos where id=?')) {
      const id = Number(params[0]); const i = mantenimientos.findIndex(m=>m.id===id);
      if (i>=0) mantenimientos.splice(i,1);
      return [{}];
    }

    // login (no hay usuarios en memoria)
    if (q.includes(' from usuarios ')) return [[]];

    console.log('[DB:MEMORY] SQL no soportado:', sql);
    return [[]];
  },
  async execute(sql, params){ return this.query(sql, params); }
};
