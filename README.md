# Horario Laboral

PWA de control de asistencia de **Diagonal Catorce**. Sirve para que cualquier negocio cumpla la reforma a la Ley Federal del Trabajo (DOF 1-may-2026), **art. 132 fracc. XXXIV**: registro electrónico obligatorio de entrada y salida de cada trabajador a partir del 1 de enero de 2027, entregable a la STPS.

> Estado: **Fase 0, base segura y sistema de diseño.** Todavía no hay checado ni reportes.

## Arquitectura

| Pieza | Qué es | Dónde |
|---|---|---|
| PWA | HTML/CSS/JS sin frameworks, publicada en GitHub Pages | raíz del repo |
| Auth | Firebase Auth (email/contraseña), proyecto `horario-laboral-d14` | Google |
| Datos | Firestore `(default)` en `northamerica-south1` (Querétaro, México) | Google |
| Proxy | Cloudflare Worker `horario-laboral-proxy`: verifica tokens, asigna roles y es el único que escribe | `worker/` |
| Evidencias | R2 privado `horario-laboral-evidencias` (sin URL pública; solo lo lee el Worker) | Cloudflare |

### Modelo multiempresa

```
usuarios/{uid}                      perfil mínimo: rol, empresaId, nombre, activo
empresas/{empresaId}
  ├─ sucursales/{id}
  ├─ trabajadores/{uid}             el id es el uid de Firebase Auth
  ├─ horarios/{id}                  campo uid = dueño
  ├─ registros/{id}                 campo uid = dueño (los escribe SOLO el Worker, hora del servidor)
  ├─ convenios/{id}                 campo uid = dueño
  └─ bitacora/{id}                  auditoría inmutable
```

**Roles** (custom claims `{ rol, empresaId }`, asignados SOLO por el Worker): `superadmin` (Diagonal Catorce), `admin_empresa`, `supervisor` y `trabajador`.

### Reglas de seguridad

- Firestore está cerrado por defecto y **ningún cliente escribe nada**: todo pasa por el Worker.
- Una cuenta sin claims no tiene ningún acceso. Esto importa porque el auto-registro de Firebase no se puede apagar sin Identity Platform.
- Además del claim, el perfil `usuarios/{uid}` tiene que estar activo y coincidir con él. Dar de baja el perfil corta el acceso al momento.
- El trabajador solo ve lo suyo, el admin y el supervisor solo ven su empresa, y nadie lee otra empresa. El superadmin solo ve la ficha de cada empresa, no los datos de sus trabajadores.
- La selfie es solo foto de evidencia, sin reconocimiento facial (no se tratan datos biométricos).

## Desarrollo

```bash
npm install
npm run hooks          # activa el escaneo de secretos antes de cada commit
npm run build:vendor   # copia el SDK de Firebase Auth y la fuente Figtree dentro del repo
npm run serve          # http://localhost:5173  ·  /diseno.html = sistema de diseño
```

Para probar contra el Worker local: `cd worker && npx wrangler dev`, con un `worker/.dev.vars` (ignorado por git) que tenga `DEV_ORIGINS`, `SERVICE_ACCOUNT_JSON` y `SETUP_TOKEN`.

### Verificación (obligatoria antes de publicar)

```bash
npm run verificar      # pruebas del Worker + reglas (emulador) + contraste + npm audit + secretos
npm run auditar:pwa    # con `npm run serve` encendido: service worker, manifest, CSP, consola, desbordes
```

Las pruebas de reglas usan el emulador de Firestore, que necesita Java 21. `tools/con-java.mjs` usa el JDK portátil de `.tools/` (ignorado por git) si existe.

## Dependencias de terceros en tiempo de ejecución

Nada se carga desde un CDN. Todo vive dentro del repo:

- **Firebase JS SDK** (solo `app` + `auth`), de Google, Apache-2.0 → `js/vendor/firebase.js`. Se conecta únicamente a `identitytoolkit.googleapis.com` y `securetoken.googleapis.com`.
- **Figtree** (OFL-1.1) → `fonts/`.

Las dependencias de `package.json` son solo de build y de pruebas.

## Publicación

Nada se publica, despliega ni sube sin autorización explícita (regla de oro: solo sale lo verificado).
