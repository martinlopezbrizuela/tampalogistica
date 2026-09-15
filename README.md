# AGROFORCE + TAMPA — CONTROL DE STOCK (LÍNEA DE PASTURAS)

Versión de archivos simples: **8 archivos, todos sueltos en la raíz del
repositorio**. No hay ninguna carpeta — los logos de AGROFORCE y TAMPA ya
están incrustados como código adentro del `index.html`, así que no hace
falta subir ninguna imagen aparte.

## ARCHIVOS (subir cada uno tal cual, en la raíz del repositorio)

```
server.js        → TODO el backend: servidor, sesiones, base de datos y
                    la API completa (entradas, salidas, transferencias,
                    inventario, reportes, auditoría, etc). Al arrancar
                    crea las tablas solo si no existen — no hay que
                    correr ningún comando aparte.
index.html        → la única página del sistema (login + app), con los
                     logos de AGROFORCE y TAMPA y el ícono del camión ya
                     incluidos adentro del código (no son archivos aparte)
app.js              → todo el frontend (la app completa)
styles.css            → todos los estilos
package.json            → dependencias del proyecto
.env.example              → ejemplo de las variables que van en Railway
.gitignore                  → para no subir node_modules ni .env
README.md                     → este archivo
```

Eso es todo. Ninguna carpeta, ninguna imagen para subir por separado.


## CÓMO SUBIRLO DESDE EL IPAD (editor web de GitHub)

1. Entrá a tu repositorio en GitHub (o creá uno nuevo, vacío).
2. **Add file → Create new file** para cada uno de estos 8 archivos.
   Escribí el nombre tal cual (sin carpetas por delante) y pegá el
   contenido de cada uno: `server.js`, `index.html`, `app.js`,
   `styles.css`, `package.json`, `.env.example`, `.gitignore`,
   `README.md`.
3. Confirmá los commits. Listo — no hay imágenes que subir aparte.

## CÓMO CONECTARLO A RAILWAY

1. En [railway.app](https://railway.app): **New Project → Deploy from GitHub
   repo** y elegí este repositorio.
2. **New → Database → Add PostgreSQL** (dentro del mismo proyecto). Railway
   arma sola la variable `DATABASE_URL` y la conecta al servicio web.
3. En el servicio web → pestaña **Variables**, agregá:
   ```
   APP_PASSWORD=LINEADEPASTURA
   SESSION_SECRET=(algo largo y aleatorio)
   NODE_ENV=production
   ```
4. Listo — Railway detecta `package.json`, corre `npm install` y después
   `npm start` (que ejecuta `server.js`). La primera vez que arranca, el
   propio `server.js` crea las tablas y carga los 4 depósitos (CIUDAD DEL
   ESTE, ASUNCIÓN, YPACARAÍ, FILADELFIA). No hay que tocar la base de
   datos a mano.
5. Railway te da una URL pública (`https://tuapp.up.railway.app`). Entrás
   con la contraseña `LINEADEPASTURA`.

## QUÉ HACE EL SISTEMA

- Dashboard con stock total, alertas de stock bajo/crítico, vencimientos
  próximos y transferencias en tránsito.
- Depósitos, productos, stock general con semáforo verde/amarillo/rojo.
- Entradas y salidas con numeración automática (ENT-2026-000001, etc.) y
  validación: no deja sacar más stock del que hay.
- Transferencias: al despachar se resta del depósito de origen, pero
  queda "EN TRÁNSITO" y **no se suma al destino hasta que ese depósito
  confirme la recepción** (avisa si la cantidad recibida es distinta).
- Control de inventario físico: al cerrar un conteo, genera los ajustes
  automáticamente por la diferencia.
- Historial completo por producto, auditoría de todos los cambios,
  reportes descargables en CSV y Excel.
- Todo el texto del sistema en MAYÚSCULAS.

## CÓMO CAMBIAR LOS LOGOS O EL ÍCONO DEL CAMIÓN

Los logos y el ícono ya no son archivos de imagen sueltos — están dentro
del `index.html` como texto (base64). Para cambiarlos, avisame y te
regenero el `index.html` con la imagen nueva ya incrustada; solo tenés
que reemplazar ese archivo en GitHub, nada más.

## CÓMO AGREGAR PRODUCTOS O DEPÓSITOS

Todo se hace desde la app, sin tocar código: menú lateral → **PRODUCTOS**
o **DEPÓSITOS** → botón de "+ NUEVO".

## BACKUP DE LA BASE DE DATOS

Desde Railway: pestaña del plugin de PostgreSQL → **Backups**. O manual:
```
pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d).sql
```

## PRUEBAS SUGERIDAS ANTES DE USAR EN PRODUCCIÓN

1. Registrar una entrada en YPACARAÍ.
2. Registrar una salida desde YPACARAÍ.
3. Crear una transferencia YPACARAÍ → FILADELFIA y despacharla.
4. Confirmar la recepción en FILADELFIA (probar con una cantidad distinta
   para ver la alerta de diferencia).
5. Verificar que el stock de ambos depósitos quede correcto en STOCK
   GENERAL.
6. Intentar una salida por más cantidad de la disponible y confirmar que
   el sistema la bloquea.
7. Iniciar un conteo de inventario, cargar una diferencia y cerrarlo:
   confirmar que se generó el ajuste solo.
8. Revisar AUDITORÍA y confirmar que quedó todo registrado.
