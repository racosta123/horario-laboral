// Piezas comunes del Worker: respuestas, CORS, lectura y validación de entradas, sesión y bitácora.
import { HttpError, getDocument, verificarIdToken } from "./google.js";
import { randomId } from "./crypto.js";
import { contar } from "./ratelimit.js";

export const ROLES = ["superadmin", "admin_empresa", "supervisor", "trabajador"];
const MIN = 60 * 1000;
export const LIMITES = {
  ip: { max: 120, ventanaMs: MIN }, // toda petición, por IP
  uid: { max: 60, ventanaMs: MIN }, // peticiones autenticadas, por usuario
  crearEmpresa: { max: 20, ventanaMs: 60 * MIN }, // altas de empresa, por superadmin
  setup: { max: 5, ventanaMs: 60 * MIN }, // intentos de alta del superadmin, por IP
  // PIN de empleado: bloqueo por empleado y por IP (contadores separados).
  pinEmpleado: { max: 5, ventanaMs: 15 * MIN, bloqueoMs: 15 * MIN },
  pinIp: { max: 20, ventanaMs: 15 * MIN, bloqueoMs: 60 * MIN },
};
// Topes de sanidad por empresa (mercado objetivo: 5 a 50 empleados).
export const TOPES = { sitios: 100, trabajadores: 500 };

const CABECERAS = {
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
export const origenPermitido = (env, o) => !!o && origenes(env).includes(o);

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

export function responder(env, request, status, body, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CABECERAS, "content-type": "application/json; charset=utf-8", ...cors(env, request.headers.get("origin")), ...extra },
  });
}

// Imágenes privadas (foto del alta, logo): nunca en caché compartida, nunca interpretadas como otra cosa.
export class Binario {
  constructor(cuerpo, tipo) {
    this.cuerpo = cuerpo;
    this.tipo = tipo;
  }
}
export function responderBinario(env, request, b) {
  return new Response(b.cuerpo, {
    status: 200,
    headers: {
      ...CABECERAS,
      "content-type": b.tipo,
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      ...cors(env, request.headers.get("origin")),
    },
  });
}

export const ipCliente = (request) => request.headers.get("cf-connecting-ip") || "desconocida";

export async function limitar(env, clave, limite) {
  const r = await contar(env, clave, limite);
  if (r.excedido) {
    throw Object.assign(new HttpError(429, "demasiadas_peticiones"), { reintentar: Math.ceil(r.reintentarEnMs / 1000) });
  }
}

// ---- lectura y validación de entradas -------------------------------------
export const bad = (detalle) => new HttpError(400, "datos_invalidos", detalle);
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RE_RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
export const RE_ID = /^[a-f0-9]{20}$/;
export const RE_NUMERO = /^[A-Z0-9-]{1,12}$/;
export const RE_PIN = /^\d{6}$/;
export const RE_CLAVE = /^[A-HJ-NP-Z2-9]{6}$/; // sin I, O, 0 ni 1 (se confunden)
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_COLOR = /^#[0-9A-Fa-f]{6}$/;

export async function leerJson(request, max = 8192) {
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

// Imagen en el cuerpo de la petición. Se valida por su firma de bytes, no por lo que diga el cliente.
const FIRMAS = {
  "image/jpeg": (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9,
  "image/png": (b) => b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
};
export async function leerImagen(request, tiposPermitidos, max) {
  const tipo = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!tiposPermitidos.includes(tipo)) throw new HttpError(415, "tipo_no_soportado");
  const largo = Number(request.headers.get("content-length") || 0);
  if (largo > max) throw new HttpError(413, "demasiado_grande");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > max) throw new HttpError(413, "demasiado_grande");
  if (!FIRMAS[tipo](bytes)) throw bad("El archivo no es una imagen válida.");
  return { bytes, tipo };
}

export function texto(v, campo, min, max) {
  if (typeof v !== "string") throw bad(`${campo}: texto requerido.`);
  const t = v.normalize("NFC").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < min || t.length > max) throw bad(`${campo}: entre ${min} y ${max} caracteres.`);
  return t;
}
export function textoOpcional(v, campo, max) {
  if (v === undefined || v === null || v === "") return "";
  return texto(v, campo, 1, max);
}
export function correo(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(e) || e.length > 254) throw bad("Correo inválido.");
  return e;
}
export function rfc(v) {
  if (v === undefined || v === null || v === "") return "";
  const r = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!RE_RFC.test(r)) throw bad("RFC inválido.");
  return r;
}
export function id(v, campo = "id") {
  if (typeof v !== "string" || !RE_ID.test(v)) throw bad(`${campo}: identificador inválido.`);
  return v;
}
export function numero(v, campo, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(`${campo}: número entre ${min} y ${max}.`);
  return v;
}
export function entero(v, campo, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${campo}: entero entre ${min} y ${max}.`);
  return v;
}
export function booleano(v, campo) {
  if (typeof v !== "boolean") throw bad(`${campo}: sí o no.`);
  return v;
}
export function color(v, campo) {
  if (typeof v !== "string" || !RE_COLOR.test(v)) throw bad(`${campo}: color en formato #RRGGBB.`);
  return v.toUpperCase();
}
export function numeroEmpleado(v) {
  const n = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!RE_NUMERO.test(n)) throw bad("Número de empleado: 1 a 12 letras, dígitos o guiones.");
  return n;
}

// ---- tiempo (México centro, UTC-6 todo el año desde 2022) ----------------
// La empresa podrá elegir su zona en una fase posterior; para el corte mensual de cobro basta UTC-6.
const OFFSET_MS = -6 * 3600 * 1000;
export const fechaLocal = (ms = Date.now()) => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
export const mesActual = (ms = Date.now()) => fechaLocal(ms).slice(0, 7);

export function fechaNacimiento(v) {
  if (typeof v !== "string" || !RE_FECHA.test(v)) throw bad("Fecha de nacimiento: AAAA-MM-DD.");
  const [y, m, d] = v.split("-").map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) throw bad("Fecha de nacimiento inválida.");
  const [hy, hm, hd] = fechaLocal().split("-").map(Number);
  const edad = hy - y - (hm < m || (hm === m && hd < d) ? 1 : 0);
  // LFT art. 22: prohibido el trabajo de menores de 15 años (validar con el abogado).
  if (edad < 15) throw bad("La LFT prohíbe el trabajo de menores de 15 años.");
  if (edad > 100) throw bad("Fecha de nacimiento fuera de rango.");
  return v;
}

// ---- sesión ---------------------------------------------------------------
// Token válido + rol conocido en los claims + perfil activo y congruente. Sin claims: 403.
export async function autenticar(env, request) {
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
  return { uid: t.sub, rol, empresaId, nombre: perfil.nombre || "", trabajadorId: perfil.trabajadorId || "" };
}

export const exigirRol = (actor, ...roles) => {
  if (!roles.includes(actor.rol)) throw new HttpError(403, "sin_acceso");
};

// Admin de una empresa activa. Devuelve el documento de la empresa.
export async function exigirAdmin(env, request) {
  const actor = await autenticar(env, request);
  exigirRol(actor, "admin_empresa");
  if (!RE_ID.test(actor.empresaId)) throw new HttpError(403, "sin_acceso");
  const empresa = await getDocument(env, `empresas/${actor.empresaId}`);
  if (!empresa || empresa.activo !== true) throw new HttpError(403, "sin_acceso");
  return { actor, empresa };
}

// Entrada de bitácora (en el MISMO commit que el cambio; nunca se edita ni se borra).
// Nunca lleva PIN, código de gafete ni contraseñas.
export function bitacora(empresaId, actor, accion, detalle) {
  return {
    path: `empresas/${empresaId}/bitacora/${Date.now().toString(36)}-${randomId(6)}`,
    data: { actorUid: actor.uid, actorRol: actor.rol, accion, detalle },
    mustNotExist: true,
    serverTimeFields: ["ts"],
  };
}

// Escrituras de conteo para el cobro: actualiza los activos de la empresa y el máximo del mes.
// valores: { empleadosActivos, sitiosActivos } YA calculados dentro de la transacción.
export function conteos(empresaId, valores) {
  return [
    { path: `empresas/${empresaId}`, data: valores, merge: true, mustExist: true },
    {
      path: `empresas/${empresaId}/consumo/${mesActual()}`,
      data: { mes: mesActual() },
      merge: true,
      maximos: { maxEmpleados: valores.empleadosActivos, maxSitios: valores.sitiosActivos },
      serverTimeFields: ["actualizado"],
    },
  ];
}
