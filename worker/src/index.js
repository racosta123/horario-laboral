// Horario Laboral — proxy seguro (Cloudflare Worker "horario-laboral-proxy").
// Única vía de escritura a Firestore y de asignación de roles (custom claims). Sin dependencias.
import { randomId, randomPassword, safeEqual } from "./crypto.js";
import {
  HttpError, borrarCuenta, commit, crearCuenta, enviarCorreoContrasena, getDocument, verificarIdToken,
} from "./google.js";
import { RateLimiter, contar } from "./ratelimit.js";

export { RateLimiter };

export const ROLES = ["superadmin", "admin_empresa", "supervisor", "trabajador"];
const MIN = 60 * 1000;
const LIMITES = {
  ip: { max: 120, ventanaMs: MIN }, // toda petición, por IP
  uid: { max: 60, ventanaMs: MIN }, // peticiones autenticadas, por usuario
  crearEmpresa: { max: 20, ventanaMs: 60 * MIN }, // altas de empresa, por superadmin
  setup: { max: 5, ventanaMs: 60 * MIN }, // intentos de alta del superadmin, por IP
};

const CABECERAS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "x-frame-options": "DENY",
};

// Orígenes EXACTOS permitidos (sin comodines). DEV_ORIGINS solo existe en .dev.vars (wrangler dev).
function origenes(env) {
  return `${env.ALLOWED_ORIGINS || ""},${env.DEV_ORIGINS || ""}`.split(",").map((o) => o.trim()).filter(Boolean);
}
const origenPermitido = (env, o) => !!o && origenes(env).includes(o);

function cors(env, origin) {
  if (!origenPermitido(env, origin)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function responder(env, request, status, body, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CABECERAS, ...cors(env, request.headers.get("origin")), ...extra },
  });
}

const ipCliente = (request) => request.headers.get("cf-connecting-ip") || "desconocida";

async function limitar(env, clave, limite) {
  const r = await contar(env, clave, limite);
  if (r.excedido) {
    throw Object.assign(new HttpError(429, "demasiadas_peticiones"), { reintentar: Math.ceil(r.reintentarEnMs / 1000) });
  }
}

// ---- validación de entradas -----------------------------------------------
const bad = (detalle) => new HttpError(400, "datos_invalidos", detalle);
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RE_RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

async function leerJson(request, max = 8192) {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) throw new HttpError(415, "tipo_no_soportado");
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "demasiado_grande");
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw bad("JSON inválido.");
  }
}

function texto(v, campo, min, max) {
  if (typeof v !== "string") throw bad(`${campo}: texto requerido.`);
  const t = v.normalize("NFC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (t.length < min || t.length > max) throw bad(`${campo}: entre ${min} y ${max} caracteres.`);
  return t;
}

function correo(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(e) || e.length > 254) throw bad("Correo inválido.");
  return e;
}

function rfc(v) {
  if (v === undefined || v === null || v === "") return "";
  const r = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!RE_RFC.test(r)) throw bad("RFC inválido.");
  return r;
}

// ---- autenticación --------------------------------------------------------
// Token válido + rol conocido en los claims + perfil activo y congruente. Sin claims: 403.
async function autenticar(env, request) {
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(request.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, "no_autorizado");
  const t = await verificarIdToken(env, m[1]);
  const rol = typeof t.rol === "string" ? t.rol : "";
  const empresaId = typeof t.empresaId === "string" ? t.empresaId : "";
  if (!ROLES.includes(rol)) throw new HttpError(403, "sin_acceso");
  await limitar(env, `uid:${t.sub}`, LIMITES.uid);
  const perfil = await getDocument(env, `usuarios/${t.sub}`);
  if (!perfil || perfil.activo !== true || perfil.rol !== rol || (perfil.empresaId || "") !== empresaId) {
    throw new HttpError(403, "sin_acceso");
  }
  return { uid: t.sub, rol, empresaId, nombre: perfil.nombre || "" };
}

const exigirRol = (actor, ...roles) => {
  if (!roles.includes(actor.rol)) throw new HttpError(403, "sin_acceso");
};

// Entrada de bitácora (se escribe en el MISMO commit que el cambio; nunca se edita ni se borra).
function bitacora(empresaId, actor, accion, detalle) {
  return {
    path: `empresas/${empresaId}/bitacora/${Date.now().toString(36)}-${randomId(6)}`,
    data: { actorUid: actor.uid, actorRol: actor.rol, accion, detalle },
    mustNotExist: true,
    serverTimeFields: ["ts"],
  };
}

// ---- handlers -------------------------------------------------------------
async function yo(env, request) {
  const a = await autenticar(env, request);
  let empresa = null;
  if (a.empresaId) {
    const e = await getDocument(env, `empresas/${a.empresaId}`);
    if (e) empresa = { id: a.empresaId, nombre: e.nombre };
  }
  return { uid: a.uid, rol: a.rol, nombre: a.nombre, empresa };
}

// Alta de empresa + su primer admin_empresa (solo superadmin).
async function crearEmpresa(env, request) {
  const actor = await autenticar(env, request);
  exigirRol(actor, "superadmin");
  await limitar(env, `crear:${actor.uid}`, LIMITES.crearEmpresa);
  const body = await leerJson(request);
  const nombre = texto(body.nombre, "Nombre de la empresa", 2, 120);
  const rfcEmpresa = rfc(body.rfc);
  const admin = body.admin && typeof body.admin === "object" ? body.admin : {};
  const adminNombre = texto(admin.nombre, "Nombre del administrador", 2, 80);
  const adminEmail = correo(admin.email);

  const empresaId = randomId(10);
  const claims = { rol: "admin_empresa", empresaId };
  const uid = await crearCuenta(env, { email: adminEmail, password: randomPassword(), displayName: adminNombre, claims });
  try {
    await commit(env, [
      {
        path: `empresas/${empresaId}`,
        data: { nombre, rfc: rfcEmpresa, activo: true, creadaPor: actor.uid },
        mustNotExist: true,
        serverTimeFields: ["creada"],
      },
      {
        path: `usuarios/${uid}`,
        data: { rol: "admin_empresa", empresaId, nombre: adminNombre, activo: true },
        mustNotExist: true,
        serverTimeFields: ["creado"],
      },
      bitacora(empresaId, actor, "empresa_creada", { nombre, adminUid: uid }),
    ]);
  } catch (e) {
    await borrarCuenta(env, uid).catch(() => {});
    throw e;
  }
  const correoEnviado = await enviarCorreoContrasena(env, adminEmail).catch(() => false);
  return { empresaId, adminUid: uid, correoEnviado };
}

// Alta ÚNICA del superadmin. Requiere el secret SETUP_TOKEN y solo funciona mientras no exista uno.
// Después de usarlo: `wrangler secret delete SETUP_TOKEN`.
async function setupSuperadmin(env, request) {
  await limitar(env, `setup:${ipCliente(request)}`, LIMITES.setup);
  const esperado = env.SETUP_TOKEN || "";
  const dado = (/^Bearer (.+)$/.exec(request.headers.get("authorization") || "") || [])[1] || "";
  if (esperado.length < 32 || !(await safeEqual(dado, esperado))) throw new HttpError(404, "no_encontrado");
  if (await getDocument(env, "plataforma/superadmin")) throw new HttpError(409, "ya_existe");
  const body = await leerJson(request);
  const nombre = texto(body.nombre, "Nombre", 2, 80);
  const email = correo(body.email);
  const uid = await crearCuenta(env, { email, password: randomPassword(), displayName: nombre, claims: { rol: "superadmin" } });
  try {
    await commit(env, [
      { path: "plataforma/superadmin", data: { uid }, mustNotExist: true, serverTimeFields: ["creado"] },
      { path: `usuarios/${uid}`, data: { rol: "superadmin", empresaId: "", nombre, activo: true }, mustNotExist: true, serverTimeFields: ["creado"] },
    ]);
  } catch (e) {
    await borrarCuenta(env, uid).catch(() => {});
    throw e;
  }
  const correoEnviado = await enviarCorreoContrasena(env, email).catch(() => false);
  return { uid, correoEnviado };
}

const RUTAS = {
  "GET /salud": async () => ({ ok: true }),
  "GET /v1/yo": yo,
  "POST /v1/empresas": crearEmpresa,
  "POST /v1/setup/superadmin": setupSuperadmin,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    try {
      // Un navegador en un origen no permitido no recibe nada (además de que CORS lo bloquearía).
      if (origin && !origenPermitido(env, origin)) throw new HttpError(403, "origen_no_permitido");
      if (request.method === "OPTIONS") return responder(env, request, 204, null);

      await limitar(env, `ip:${ipCliente(request)}`, LIMITES.ip);
      const handler = RUTAS[`${request.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, "no_encontrado");
      return responder(env, request, 200, await handler(env, request));
    } catch (e) {
      if (e instanceof HttpError) {
        const extra = e.reintentar ? { "retry-after": String(e.reintentar) } : {};
        return responder(env, request, e.status, { error: e.code, ...(e.detalle ? { detalle: e.detalle } : {}) }, extra);
      }
      console.error("error_interno", e?.name); // sin detalles que puedan contener datos
      return responder(env, request, 500, { error: "error_interno" });
    }
  },
};
