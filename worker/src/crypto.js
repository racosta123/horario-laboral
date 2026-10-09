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

// ---- PIN de empleado --------------------------------------------------------
// Hash = PBKDF2-SHA256( HMAC-SHA256(PIN_PEPPER, pin), sal ).
// PIN_PEPPER es un secret del Worker (wrangler secret): NUNCA se guarda en Firestore. Sin él, los hashes
// de Firestore no sirven para adivinar PINs aunque se filtraran. Las iteraciones se guardan por registro
// para poder subirlas después sin invalidar los PINs existentes (el plan gratuito limita el CPU a ~10 ms).
export const PIN_ITERACIONES = 5000;

export async function hashPin(pin, salB64u, pepper, iteraciones = PIN_ITERACIONES) {
  if (typeof pepper !== "string" || pepper.length < 32) throw new Error("PIN_PEPPER no configurado");
  const hk = await crypto.subtle.importKey("raw", te.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const pre = await crypto.subtle.sign("HMAC", hk, te.encode(pin));
  const k = await crypto.subtle.importKey("raw", pre, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64uToBytes(salB64u), iterations: iteraciones }, k, 256);
  return b64u(bits);
}

export const nuevaSal = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

// PIN aleatorio de 6 dígitos, sin patrones obvios (todos iguales o consecutivos).
export function nuevoPin() {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n >= 4294000000) continue; // evita sesgo de módulo
    const pin = String(n % 1000000).padStart(6, "0");
    const d = [...pin].map(Number);
    const iguales = d.every((x) => x === d[0]);
    const sube = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    const baja = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
    if (!iguales && !sube && !baja) return pin;
  }
}

// ---- Códigos opacos -----------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648: solo A-Z y 2-7 (seguro con cualquier teclado)
export function base32(bytes) {
  let bits = 0, valor = 0, out = "";
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31];
  return out;
}

// Código del gafete: "HL1" + 128 bits aleatorios en base32 (26 caracteres). No contiene datos personales.
export const RE_GAFETE = /^HL1[A-Z2-7]{26}$/;
export const nuevoCodigoGafete = () => `HL1${base32(crypto.getRandomValues(new Uint8Array(16)))}`;

// Clave de empresa para el inicio de sesión de empleados: 6 caracteres sin I, O, 0 ni 1.
const CLAVE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function nuevaClaveEmpresa() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CLAVE[b % 32]).join("");
}

export async function sha256Hex(s) {
  const h = await crypto.subtle.digest("SHA-256", te.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
