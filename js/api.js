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

export async function api(metodo, ruta, cuerpo) {
  const headers = { authorization: `Bearer ${await idToken()}` };
  if (cuerpo !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${WORKER_URL}${ruta}`, {
      method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ErrorApi(0, "sin_conexion");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ErrorApi(res.status, j.error || "error", j.detalle);
  return j;
}
