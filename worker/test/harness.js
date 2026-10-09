// Entorno de pruebas: Google simulado en memoria (OAuth, JWKS, Firestore REST, Identity Toolkit)
// y Durable Objects en memoria con la clase RateLimiter real.
import { b64u, signJwt } from "../src/crypto.js";
import { RateLimiter } from "../src/ratelimit.js";
import { resetCaches } from "../src/google.js";
import worker from "../src/index.js";

export const PROJECT = "hl-test";
export const ORIGIN = "https://racosta123.github.io";
export const SETUP = "setup-token-de-prueba-0123456789abcdefXYZ";

// Llave generada en memoria en cada corrida (no hay ninguna llave real en el código).
const marca = (t) => `-----${t} PRIVATE KEY-----`;
const toPem = (der) => `${marca("BEGIN")}\n${Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n")}\n${marca("END")}\n`;
const genKey = () => crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

export async function crearMundo() {
  resetCaches();
  const sa = await genKey();
  const st = await genKey(); // firma de ID tokens (securetoken de Google)
  const intruso = await genKey(); // llave que NO es de Google
  const stJwk = { ...(await crypto.subtle.exportKey("jwk", st.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  const docs = new Map(); // ruta -> campos (formato Firestore)
  const cuentas = new Map(); // uid -> { email, claims }
  const mundo = { docs, cuentas, correos: [], llamadas: [] };

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
    SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@hl-test.iam.gserviceaccount.com", private_key: toPem(await crypto.subtle.exportKey("pkcs8", sa.privateKey)) }),
    RATE_LIMITER,
    EVIDENCIAS: {},
  };

  const pref = `/v1/projects/${PROJECT}/databases/(default)/documents/`;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    mundo.llamadas.push(`${init.method || "GET"} ${u.host}${u.pathname}`);
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "at-test", expires_in: 3600 });
    if (u.host === "www.googleapis.com") return json({ keys: [stJwk] });
    if (u.host === "firestore.googleapis.com") {
      if (u.pathname.endsWith(":commit")) {
        if (mundo.fallarCommit) return json({ error: { status: "INTERNAL" } }, 500);
        const { writes } = JSON.parse(init.body);
        for (const w of writes) if (w.currentDocument?.exists === false && docs.has(w.update.name)) return json({ error: { status: "ALREADY_EXISTS" } }, 409);
        for (const w of writes) docs.set(w.update.name, { ...w.update.fields, ...Object.fromEntries((w.updateTransforms || []).map((t) => [t.fieldPath, { timestampValue: "2026-10-08T00:00:00Z" }])) });
        return json({});
      }
      const nombre = decodeURIComponent(u.pathname).replace(/^\/v1\//, "");
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
      if (u.pathname.endsWith("accounts:update")) { cuentas.get(b.localId).claims = JSON.parse(b.customAttributes); return json({}); }
      if (u.pathname.endsWith("accounts:delete")) { cuentas.delete(b.localId); return json({}); }
      if (u.pathname.endsWith("accounts:sendOobCode")) { mundo.correos.push(b.email); return json({}); }
    }
    throw new Error(`fetch inesperado: ${u}`);
  };

  // Guarda un documento con valores JS planos.
  mundo.poner = (ruta, data) => {
    const enc = (v) => (typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : { integerValue: String(v) });
    docs.set(`projects/${PROJECT}/databases/(default)/documents/${ruta}`, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])));
  };
  mundo.leer = (ruta) => {
    const f = docs.get(`projects/${PROJECT}/databases/(default)/documents/${ruta}`);
    return f && Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Object.values(v)[0]]));
  };
  mundo.rutas = () => [...docs.keys()].map((k) => k.slice(pref.length - 4));

  // ID token firmado como lo haría Google (o con la llave de un intruso).
  mundo.token = async (uid, claims = {}, { llave = st.privateKey, kid = "k1", ...over } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({
      iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, auth_time: now - 10, iat: now - 10, exp: now + 3600, ...claims, ...over,
    }, llave, { kid });
  };
  mundo.llaveIntruso = intruso.privateKey;

  let ip = 1;
  mundo.pedir = async (metodo, ruta, { token, body, origin = ORIGIN, ipFija, headers = {} } = {}) => {
    const h = { "cf-connecting-ip": ipFija || `10.0.0.${ip++ % 250}`, ...headers };
    if (origin) h.origin = origin;
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await worker.fetch(new Request(`https://proxy.test${ruta}`, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), mundo.env);
    const texto = await res.text();
    return { status: res.status, headers: res.headers, body: texto ? JSON.parse(texto) : null };
  };
  return mundo;
}

export { b64u };
