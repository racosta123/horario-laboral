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

export async function getDocument(env, path) {
  const res = await google(env, `${URLS.firestore}/${docsBase(env)}/${path}`, null, "GET");
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, "upstream_firestore");
  const j = await res.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, dec(v)]));
}

// writes: [{ path, data, mustNotExist?, serverTimeFields? }] — todo en UNA transacción atómica.
export async function commit(env, writes) {
  const body = {
    writes: writes.map((w) => {
      const out = { update: { name: `${docsBase(env)}/${w.path}`, fields: enc(w.data).mapValue.fields } };
      if (w.mustNotExist) out.currentDocument = { exists: false };
      if (w.serverTimeFields?.length) {
        out.updateTransforms = w.serverTimeFields.map((f) => ({ fieldPath: f, setToServerValue: "REQUEST_TIME" }));
      }
      return out;
    }),
  };
  const res = await google(env, `${URLS.firestore}/${docsBase(env)}:commit`, body);
  if (res.ok) return;
  const j = await res.json().catch(() => ({}));
  const st = j?.error?.status;
  if (res.status === 409 || st === "ALREADY_EXISTS" || st === "FAILED_PRECONDITION") throw new HttpError(409, "ya_existe");
  throw new HttpError(502, "upstream_firestore");
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
