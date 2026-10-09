// Entorno de pruebas: Google simulado en memoria (OAuth, JWKS, Firestore REST con transacciones,
// Identity Toolkit), R2 en memoria y Durable Objects en memoria con la clase RateLimiter real.
import { b64u, b64uToBytes, signJwt } from "../src/crypto.js";
import { RateLimiter } from "../src/ratelimit.js";
import { dec, enc, resetCaches } from "../src/google.js";
import worker from "../src/index.js";

export const PROJECT = "hl-test";
export const ORIGIN = "https://racosta123.github.io";
export const SETUP = "setup-token-de-prueba-0123456789abcdefXYZ";
export const PEPPER = "pimienta-de-prueba-0123456789abcdef-0123456789";

// Llave generada en memoria en cada corrida (no hay ninguna llave real en el código).
const marca = (t) => `-----${t} PRIVATE KEY-----`;
const toPem = (der) => `${marca("BEGIN")}\n${Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n")}\n${marca("END")}\n`;
const genKey = () => crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

const BASE = `projects/${PROJECT}/databases/(default)/documents/`;
const decCampos = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));
const num = (v) => (v ? Number(v.integerValue ?? v.doubleValue ?? 0) : 0);

export async function crearMundo() {
  resetCaches();
  const sa = await genKey();
  const st = await genKey(); // firma de ID tokens (securetoken de Google)
  const intruso = await genKey(); // llave que NO es de Google
  const stJwk = { ...(await crypto.subtle.exportKey("jwk", st.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  const docs = new Map(); // ruta completa -> campos (formato Firestore)
  const cuentas = new Map(); // uid -> { email, claims, deshabilitada, validSince }
  const objetos = new Map(); // R2: clave -> { bytes, tipo }
  const mundo = { docs, cuentas, objetos, correos: [], llamadas: [], commits: [], txAbortar: 0 };

  const dos = new Map();
  const RATE_LIMITER = {
    idFromName: (n) => n,
    get: (id) => {
      if (!dos.has(id)) {
        const m = new Map();
        dos.set(id, new RateLimiter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }));
      }
      const obj = dos.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };

  mundo.env = {
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: ORIGIN,
    SETUP_TOKEN: SETUP,
    PIN_PEPPER: PEPPER,
    SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@hl-test.iam.gserviceaccount.com", private_key: toPem(await crypto.subtle.exportKey("pkcs8", sa.privateKey)) }),
    RATE_LIMITER,
    EVIDENCIAS: {
      async put(k, v) { objetos.set(k, { bytes: new Uint8Array(v) }); },
      async get(k) { const o = objetos.get(k); return o ? { body: new Response(o.bytes).body } : null; },
      async delete(k) { objetos.delete(k); },
    },
  };

  // ---- Firestore simulado ----
  let txN = 0;
  function aplicar(w) {
    if (w.delete) { docs.delete(w.delete); return; }
    const nombre = w.update.name;
    let campos;
    if (w.updateMask) {
      campos = { ...(docs.get(nombre) || {}) };
      for (const p of w.updateMask.fieldPaths) {
        const k = p.replace(/`/g, "");
        if (k in w.update.fields) campos[k] = w.update.fields[k]; else delete campos[k];
      }
    } else {
      campos = { ...w.update.fields };
    }
    for (const t of w.updateTransforms || []) {
      if (t.setToServerValue) campos[t.fieldPath] = { timestampValue: new Date().toISOString() };
      else if (t.increment) campos[t.fieldPath] = { integerValue: String(num(campos[t.fieldPath]) + num(t.increment)) };
      else if (t.maximum) campos[t.fieldPath] = { integerValue: String(Math.max(num(campos[t.fieldPath]), num(t.maximum))) };
    }
    docs.set(nombre, campos);
  }

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    mundo.llamadas.push(`${init.method || "GET"} ${u.host}${u.pathname}`);
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "at-test", expires_in: 3600 });
    if (u.host === "www.googleapis.com") return json({ keys: [stJwk] });
    if (u.host === "firestore.googleapis.com") {
      const p = decodeURIComponent(u.pathname);
      if (p.endsWith(":beginTransaction")) return json({ transaction: `tx-${++txN}` });
      if (p.endsWith(":rollback")) return json({});
      if (p.endsWith(":commit")) {
        if (mundo.fallarCommit) return json({ error: { status: "INTERNAL" } }, 500);
        const { writes, transaction } = JSON.parse(init.body);
        if (transaction && mundo.txAbortar > 0) { mundo.txAbortar--; return json({ error: { status: "ABORTED" } }, 409); }
        for (const w of writes) {
          const n = w.delete || w.update.name;
          if (w.currentDocument?.exists === false && docs.has(n)) return json({ error: { status: "ALREADY_EXISTS" } }, 409);
          if (w.currentDocument?.exists === true && !docs.has(n)) return json({ error: { status: "NOT_FOUND" } }, 404);
        }
        // Una escritura por documento por commit (como exige Firestore en la práctica para este código).
        const nombres = writes.map((w) => w.delete || w.update.name);
        if (new Set(nombres).size !== nombres.length) return json({ error: { status: "INVALID_ARGUMENT", message: "documento repetido" } }, 400);
        for (const w of writes) aplicar(w);
        mundo.commits.push(writes);
        return json({});
      }
      const nombre = p.replace(/^\/v1\//, "");
      return docs.has(nombre) ? json({ name: nombre, fields: docs.get(nombre) }) : json({ error: { status: "NOT_FOUND" } }, 404);
    }
    if (u.host === "identitytoolkit.googleapis.com") {
      const b = JSON.parse(init.body || "{}");
      if (u.pathname.endsWith("/accounts")) {
        if ([...cuentas.values()].some((c) => c.email === b.email)) return json({ error: { message: "EMAIL_EXISTS" } }, 400);
        const uid = `uid-${cuentas.size + 1}`;
        cuentas.set(uid, { email: b.email, claims: null, password: b.password });
        return json({ localId: uid });
      }
      if (u.pathname.endsWith("accounts:update")) {
        const c = cuentas.get(b.localId);
        if (!c) return json({ error: { message: "USER_NOT_FOUND" } }, 400);
        if (b.customAttributes) c.claims = JSON.parse(b.customAttributes);
        if ("disableUser" in b) c.deshabilitada = b.disableUser;
        if (b.validSince) c.validSince = b.validSince;
        return json({});
      }
      if (u.pathname.endsWith("accounts:delete")) { cuentas.delete(b.localId); return json({}); }
      if (u.pathname.endsWith("accounts:sendOobCode")) { mundo.correos.push(b.email); return json({}); }
    }
    throw new Error(`fetch inesperado: ${u}`);
  };

  // Guarda / lee documentos con valores JS planos.
  mundo.poner = (ruta, data) => docs.set(BASE + ruta, enc(data).mapValue.fields);
  mundo.leer = (ruta) => (docs.has(BASE + ruta) ? decCampos(docs.get(BASE + ruta)) : undefined);
  mundo.rutas = (prefijo = "") => [...docs.keys()].map((k) => k.slice(BASE.length)).filter((k) => k.startsWith(prefijo));

  // ID token firmado como lo haría Google (o con la llave de un intruso).
  mundo.token = async (uid, claims = {}, { llave = st.privateKey, kid = "k1", ...over } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({
      iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, auth_time: now - 10, iat: now - 10, exp: now + 3600, ...claims, ...over,
    }, llave, { kid });
  };
  mundo.llaveIntruso = intruso.privateKey;

  // Verifica un token personalizado emitido por el Worker con la llave PÚBLICA de la cuenta de servicio.
  mundo.verificarTokenPersonalizado = async (jwt) => {
    const [h, p, s] = jwt.split(".");
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, b64uToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? JSON.parse(new TextDecoder().decode(b64uToBytes(p))) : null;
  };

  let ip = 1;
  mundo.pedir = async (metodo, ruta, { token, body, bytes, tipo, origin = ORIGIN, ipFija, headers = {} } = {}) => {
    const h = { "cf-connecting-ip": ipFija || `10.0.${Math.floor(ip / 250)}.${ip++ % 250}`, ...headers };
    if (origin) h.origin = origin;
    if (token) h.authorization = `Bearer ${token}`;
    let cuerpo;
    if (body !== undefined) { h["content-type"] = "application/json"; cuerpo = JSON.stringify(body); }
    if (bytes !== undefined) { h["content-type"] = tipo; h["content-length"] = String(bytes.length); cuerpo = bytes; }
    const res = await worker.fetch(new Request(`https://proxy.test${ruta}`, { method: metodo, headers: h, body: cuerpo }), mundo.env);
    const ct = res.headers.get("content-type") || "";
    if (ct.startsWith("application/json") || res.status === 204) {
      const texto = await res.text();
      return { status: res.status, headers: res.headers, body: texto ? JSON.parse(texto) : null };
    }
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  return mundo;
}

// Imágenes mínimas con firma válida.
export const JPEG = (n = 2000) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); b[n - 2] = 0xff; b[n - 1] = 0xd9; return b; };
export const PNG = (n = 1000) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };

export { b64u };
