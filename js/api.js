// Cliente del Worker. Todo lo sensible pasa por aquí con el ID token de Firebase.
import { WORKER_URL } from "./config.js";
import { idToken } from "./auth.js";

export class ErrorApi extends Error {
  constructor(status, codigo, detalle) {
    super(codigo);
    this.status = status;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

const OPCIONES = { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" };

async function enviar(ruta, init) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}${ruta}`, { ...OPCIONES, ...init });
  } catch {
    throw new ErrorApi(0, "sin_conexion");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ErrorApi(res.status, j.error || "error", j.detalle);
  return j;
}

export async function api(metodo, ruta, cuerpo) {
  const headers = { authorization: `Bearer ${await idToken()}` };
  if (cuerpo !== undefined) headers["content-type"] = "application/json";
  return enviar(ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
}

// Llamada sin sesión (solo el acceso de empleados: clave + número + PIN).
export function apiPublica(metodo, ruta, cuerpo) {
  return enviar(ruta, { method: metodo, headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) });
}

// Sube una imagen (Blob) tal cual; el Worker valida tipo, tamaño y firma de bytes.
export async function subirImagen(ruta, blob) {
  return enviar(ruta, { method: "POST", headers: { authorization: `Bearer ${await idToken()}`, "content-type": blob.type }, body: blob });
}

// Descarga una imagen privada (foto, logo) y devuelve una URL blob: local, o null si no hay.
// Quien la usa debe liberarla con URL.revokeObjectURL cuando ya no se muestre.
export async function imagenPrivada(ruta) {
  const res = await fetch(`${WORKER_URL}${ruta}`, { ...OPCIONES, headers: { authorization: `Bearer ${await idToken()}` } }).catch(() => null);
  if (!res || !res.ok) return null;
  const tipo = res.headers.get("content-type") || "";
  if (!/^image\/(jpeg|png)$/.test(tipo)) return null;
  return URL.createObjectURL(await res.blob());
}

// Mensaje claro para el usuario a partir de un error del Worker.
export function mensajeErrorApi(e, porDefecto = "No se pudo completar la operación.") {
  if (e?.codigo === "sin_conexion") return "Sin conexión. Revisa tu internet e inténtalo de nuevo.";
  if (e?.status === 429) return "Demasiadas solicitudes seguidas. Espera un momento.";
  if (e?.status === 403) return "No tienes permiso para esta acción.";
  return e?.detalle || porDefecto;
}
