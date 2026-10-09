// Utilidades criptográficas (solo WebCrypto, sin dependencias).
const te = new TextEncoder();

export function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(b64uToBytes(part)));
}

// Comparación en tiempo constante. Se comparan los SHA-256 para no filtrar la longitud.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", te.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export function randomId(bytes = 10) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Contraseña aleatoria que nadie conoce (el usuario define la suya con el correo de restablecimiento).
export function randomPassword() {
  return b64u(crypto.getRandomValues(new Uint8Array(24)));
}

function pemToDer(pem) {
  return b64uToBytes(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export async function importPrivateKey(pem) {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwt(payload, privateKey, header = {}) {
  const h = b64u(te.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...header })));
  const p = b64u(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, te.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
