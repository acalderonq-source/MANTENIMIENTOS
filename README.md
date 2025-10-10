# Mantenimientos Web — Gas Tomza (Opción 2)

Stack: Node.js + Express + MySQL + EJS + Sessions

## Requisitos
- Node.js 18+
- MySQL 8+
- Crear base de datos: `mantenimientos_db`

## Instalación
```bash
cd mantenimientos-web
copy .env.example .env   # En Windows (PowerShell: cp .env.example .env)
# Edita .env con tus credenciales MySQL
npm install
# Crear tablas y datos iniciales:
node src/seed.js
# Levantar servidor
npm run dev
```

## Credenciales iniciales
- admin / admin123

## Endpoints clave
- GET  /           → Dashboard
- GET  /login      → Login
- POST /login      → Iniciar sesión
- GET  /logout     → Cerrar sesión

- GET  /unidades           → Listado/creación de unidades
- POST /unidades           → Crear
- POST /unidades/:id/baja  → Desactivar

- GET  /mantenimientos            → Listado
- GET  /mantenimientos/nuevo      → Form nuevo
- POST /mantenimientos            → Crear mantenimiento (abre en taller)
- POST /mantenimientos/:id/cerrar → Finaliza y libera reservas

## API para Power BI
- GET /api/mantenimientos → JSON de mantenimientos (incluye campos calculados)
- GET /api/mantenimientos/proximos → Próximos sugeridos por regla 45 días / +10,000 km

## Notas
- Al crear un mantenimiento se marca la unidad como EN_TALLER y se reserva inventario lógicamente.
- Al cerrar, se completa `fecha_fin`, `duracion_dias` y libera la reserva.
