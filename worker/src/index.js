// Horario Laboral — proxy seguro (Cloudflare Worker "horario-laboral-proxy").
// Única vía de escritura a Firestore y de asignación de roles (custom claims). Sin dependencias.
import { HttpError } from "./google.js";
import { RateLimiter } from "./ratelimit.js";
import { Binario, LIMITES, ipCliente, limitar, origenPermitido, responder, responderBinario } from "./base.js";
import { crearEmpresa, setupSuperadmin, yo } from "./handlers/plataforma.js";
import { crearSitio, editarSitio, estadoSitio } from "./handlers/sitios.js";
import {
  altaTrabajador, editarTrabajador, estadoTrabajador, restablecerPin, subirFoto, verFoto,
} from "./handlers/trabajadores.js";
import { emitirGafete, revocarGafete } from "./handlers/gafetes.js";
import { guardarConfig, guardarMarca, subirLogo, verLogo } from "./handlers/empresa.js";
import { entrarEmpleado } from "./handlers/entrar.js";

export { RateLimiter };

const RUTAS = {
  "GET /salud": async () => ({ ok: true }),
  "GET /v1/yo": yo,
  "POST /v1/empresas": crearEmpresa,
  "POST /v1/setup/superadmin": setupSuperadmin,
  // Empresa (admin_empresa)
  "POST /v1/sitios": crearSitio,
  "POST /v1/sitios/editar": editarSitio,
  "POST /v1/sitios/estado": estadoSitio,
  "POST /v1/trabajadores": altaTrabajador,
  "POST /v1/trabajadores/editar": editarTrabajador,
  "POST /v1/trabajadores/estado": estadoTrabajador,
  "POST /v1/trabajadores/pin": restablecerPin,
  "POST /v1/trabajadores/foto": subirFoto,
  "GET /v1/trabajadores/foto": verFoto,
  "POST /v1/trabajadores/gafete": emitirGafete,
  "POST /v1/trabajadores/gafete/revocar": revocarGafete,
  "POST /v1/empresa/marca": guardarMarca,
  "POST /v1/empresa/config": guardarConfig,
  "POST /v1/empresa/logo": subirLogo,
  "GET /v1/empresa/logo": verLogo,
  // Empleados (público, con bloqueo por intentos)
  "POST /v1/empleado/entrar": entrarEmpleado,
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
      const r = await handler(env, request);
      return r instanceof Binario ? responderBinario(env, request, r) : responder(env, request, 200, r);
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
