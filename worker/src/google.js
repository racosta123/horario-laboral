// Acceso a Google con la cuenta de servicio (OAuth, Firestore REST, Identity Toolkit)
// y verificación de ID tokens de Firebase. Sin dependencias.
import { b64uToBytes, decodeJwtPart, importPrivateKey, signJwt } from "./crypto.js";

const URLS = {
  token: "https://oauth2.googleapis.com/token",
  firestore: "https://firestore.googleapis.com/v1",
  idtk: "https://identitytoolkit.googleapis.com/v1",
  jwks: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
};

export class HttpError extends Error {
  constructor(status, code, detalle) {
    super(code);
    this.status = status;
    this.code = code;
    this.detalle = detalle;
  }
}

// ---- cuenta de servicio y token de acceso ---------------------------------
let saCache = null;
async function cuentaServicio(env) {
  if (saCache?.raw === env.SERVICE_ACCOUNT_JSON) return saCache;
  if (!env.SERVICE_ACCOUNT_JSON) throw new HttpError(503, "no_configurado");
  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON.replace(/^﻿/, "").trim());
  saCache = { raw: env.SERVICE_ACCOUNT_JSON, sa, key: await importPrivateKey(sa.private_key) };
  return saCache;
}

let tokCache = { token: null, exp: 0 };
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokCache.token && tokCache.exp - 60 > now) return tokCache.token;
  const { sa, key } = await cuentaServicio(env);
  const assertion = await signJwt(
    { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: URLS.token, iat: now, exp: now + 3600 },
    key,
  );
  const res = await fetch(URLS.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new HttpError(502, "upstream_auth");
  const j = await res.json();
  tokCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokCache.token;
}

async function google(env, url, body, method = "POST") {
  const token = await accessToken(env);
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function resetCaches() {
  saCache = null;
  tokCache = { token: null, exp: 0 };
  jwksCache = { keys: null, exp: 0 };
}

// ---- Firestore (REST) -----------------------------------------------------
export function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === "number" && Number.isFinite(v)) return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
  }
  throw new Error("tipo no soportado");
}

export function dec(f) {
  if ("stringValue" in f) return f.stringValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("timestampValue" in f) return f.timestampValue;
  if ("nullValue" in f) return null;
  if ("arrayValue" in f) return (f.arrayValue.values || []).map(dec);
  if ("mapValue" in f) return Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return undefined;
}

const docsBase = (env) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// tx: id de transacción (opcional). La lectura dentro de una transacción la bloquea hasta el commit.
export async function getDocument(env, path, tx) {
  const q = tx ? `?transaction=${encodeURIComponent(tx)}` : "";
  const res = await google(env, `${URLS.firestore}/${docsBase(env)}/${path}${q}`, null, "GET");
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status === 409 ? 409 : 502, res.status === 409 ? "conflicto" : "upstream_firestore");
  const j = await res.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, dec(v)]));
}

// writes: [{ path, data, merge?, mustExist?, mustNotExist?, serverTimeFields?, incrementos?, maximos?, borrar? }]
//   merge: actualiza SOLO los campos de data (los demás se conservan).
//   incrementos / maximos: { campo: n } → se aplican en el servidor de forma atómica.
//   borrar: elimina el documento.
// Todo va en UN commit atómico; con tx, además dentro de la transacción.
export async function commit(env, writes, tx) {
  const body = {
    writes: writes.map((w) => {
      if (w.borrar) return { delete: `${docsBase(env)}/${w.path}` };
      const data = w.data || {};
      const out = { update: { name: `${docsBase(env)}/${w.path}`, fields: Object.keys(data).length ? enc(data).mapValue.fields : {} } };
      if (w.merge) out.updateMask = { fieldPaths: Object.keys(data).map((k) => `\`${k}\``) };
      if (w.mustNotExist) out.currentDocument = { exists: false };
      if (w.mustExist) out.currentDocument = { exists: true };
      const t = [
        ...(w.serverTimeFields || []).map((f) => ({ fieldPath: f, setToServerValue: "REQUEST_TIME" })),
        ...Object.entries(w.incrementos || {}).map(([f, n]) => ({ fieldPath: f, increment: enc(n) })),
        ...Object.entries(w.maximos || {}).map(([f, n]) => ({ fieldPath: f, maximum: enc(n) })),
      ];
      if (t.length) out.updateTransforms = t;
      return out;
    }),
  };
  if (tx) body.transaction = tx;
  const res = await google(env, `${URLS.firestore}/${docsBase(env)}:commit`, body);
  if (res.ok) return;
  const j = await res.json().catch(() => ({}));
  const st = j?.error?.status;
  if (st === "ABORTED") throw new HttpError(409, "conflicto");
  if (st === "NOT_FOUND") throw new HttpError(404, "no_encontrado");
  if (res.status === 409 || st === "ALREADY_EXISTS" || st === "FAILED_PRECONDITION") throw new HttpError(409, "ya_existe");
  throw new HttpError(502, "upstream_firestore");
}

// Ejecuta fn(tx) dentro de una transacción de Firestore; reintenta si otra petición tocó lo mismo.
// fn debe leer con getDocument(env, ruta, tx) y devolver { writes, resultado }.
export async function conTransaccion(env, fn, intentos = 4) {
  for (let i = 1; ; i++) {
    const r = await google(env, `${URLS.firestore}/${docsBase(env)}:beginTransaction`, { options: { readWrite: {} } });
    if (!r.ok) throw new HttpError(502, "upstream_firestore");
    const tx = (await r.json()).transaction;
    try {
      const { writes, resultado } = await fn(tx);
      await commit(env, writes, tx);
      return resultado;
    } catch (e) {
      if (e instanceof HttpError && e.code === "conflicto" && i < intentos) continue;
      if (!(e instanceof HttpError && e.code === "conflicto")) {
        await google(env, `${URLS.firestore}/${docsBase(env)}:rollback`, { transaction: tx }).catch(() => {});
      }
      throw e;
    }
  }
}

// Consulta simple por igualdad de un campo dentro de una colección (o subcolección) de un documento padre.
export async function consultar(env, padre, coleccion, campo, valor, limite = 50) {
  const url = `${URLS.firestore}/${docsBase(env)}${padre ? `/${padre}` : ""}:runQuery`;
  const res = await google(env, url, {
    structuredQuery: {
      from: [{ collectionId: coleccion }],
      where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: enc(valor) } },
      limit: limite,
    },
  });
  if (!res.ok) throw new HttpError(502, "upstream_firestore");
  return (await res.json()).filter((x) => x.document).map((x) => ({
    id: x.document.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, dec(v)])),
  }));
}

// ---- Identity Toolkit (administración de cuentas) -------------------------
const idtk = (env, op) => `${URLS.idtk}/projects/${env.FIREBASE_PROJECT_ID}/${op}`;

// Crea la cuenta y le asigna los custom claims. Si los claims fallan, borra la cuenta (no quedan huérfanas).
export async function crearCuenta(env, { email, password, displayName, claims }) {
  const res = await google(env, idtk(env, "accounts"), { email, password, displayName, emailVerified: false });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (String(j?.error?.message || "").includes("EMAIL_EXISTS")) throw new HttpError(409, "correo_existente");
    throw new HttpError(502, "upstream_identity");
  }
  try {
    await asignarClaims(env, j.localId, claims);
  } catch (e) {
    await borrarCuenta(env, j.localId).catch(() => {});
    throw e;
  }
  return j.localId;
}

export async function asignarClaims(env, uid, claims) {
  const res = await google(env, idtk(env, "accounts:update"), { localId: uid, customAttributes: JSON.stringify(claims) });
  if (!res.ok) throw new HttpError(502, "upstream_identity");
}

export async function borrarCuenta(env, uid) {
  await google(env, idtk(env, "accounts:delete"), { localId: uid });
}

// Firebase envía al usuario el correo para definir su contraseña. La contraseña inicial es aleatoria
// y nunca se devuelve ni se guarda.
export async function enviarCorreoContrasena(env, email) {
  const res = await google(env, `${URLS.idtk}/accounts:sendOobCode`, {
    requestType: "PASSWORD_RESET", email, targetProjectId: env.FIREBASE_PROJECT_ID,
  });
  return res.ok;
}

// Inhabilita o habilita una cuenta. Al inhabilitar también revoca sus sesiones (validSince = ahora).
// Si la cuenta aún no existe en Auth (empleado que nunca entró) no hay nada que hacer.
export async function estadoCuenta(env, uid, { activa }) {
  const body = { localId: uid, disableUser: !activa };
  if (!activa) body.validSince = String(Math.floor(Date.now() / 1000));
  const res = await google(env, idtk(env, "accounts:update"), body);
  if (res.ok) return true;
  const j = await res.json().catch(() => ({}));
  if (String(j?.error?.message || "").includes("USER_NOT_FOUND")) return false;
  throw new HttpError(502, "upstream_identity");
}

// Token personalizado de Firebase (empleados: entran con número + PIN, sin contraseña ni correo).
// Se firma con la llave de la cuenta de servicio, en el Worker; no requiere permisos extra de IAM.
// Los claims viajan en el token y Firebase los incluye en el ID token de esa sesión.
export async function tokenPersonalizado(env, uid, claims) {
  const { sa, key } = await cuentaServicio(env);
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 300,
    uid,
    claims,
  }, key);
}

// ---- Verificación de ID tokens de Firebase --------------------------------
let jwksCache = { keys: null, exp: 0 };
async function llavesPublicas(forzar = false) {
  const now = Date.now();
  if (!forzar && jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(URLS.jwks);
  if (!res.ok) throw new HttpError(502, "upstream_jwks");
  const j = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
  jwksCache = { keys: j.keys, exp: now + Math.min(maxAge, 21600) * 1000 };
  return j.keys;
}

export async function verificarIdToken(env, token) {
  const no = () => new HttpError(401, "no_autorizado");
  if (typeof token !== "string" || token.length > 4096) throw no();
  const partes = token.split(".");
  if (partes.length !== 3) throw no();
  let header, payload;
  try {
    header = decodeJwtPart(partes[0]);
    payload = decodeJwtPart(partes[1]);
  } catch {
    throw no();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw no();

  let jwk = (await llavesPublicas()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await llavesPublicas(true)).find((k) => k.kid === header.kid); // rotación de llaves
  if (!jwk) throw no();
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64uToBytes(partes[2]), new TextEncoder().encode(`${partes[0]}.${partes[1]}`));
  if (!ok) throw no();

  const now = Math.floor(Date.now() / 1000);
  const pid = env.FIREBASE_PROJECT_ID;
  if (payload.aud !== pid || payload.iss !== `https://securetoken.google.com/${pid}`) throw no();
  if (typeof payload.exp !== "number" || payload.exp <= now) throw no();
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw no();
  if (typeof payload.auth_time !== "number" || payload.auth_time > now + 60) throw no();
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw no();
  return payload;
}
