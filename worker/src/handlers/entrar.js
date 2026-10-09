// Inicio de sesión de empleados: clave de la empresa + número de empleado + PIN (sin correo ni contraseña).
// Si todo coincide, el Worker emite un token personalizado de Firebase con { rol: "trabajador", empresaId }.
// Defensas:
//   - Bloqueo por empleado (5 fallos / 15 min → 15 min) y por IP (20 fallos / 15 min → 60 min).
//   - Mismo mensaje de error para todo (no revela si existe la empresa, el número o si está bloqueado).
//   - Se calcula el hash aunque el empleado no exista, para que el tiempo de respuesta no lo delate.
import { PIN_ITERACIONES, hashPin, safeEqual } from "../crypto.js";
import { HttpError, getDocument, tokenPersonalizado } from "../google.js";
import { consultarBloqueo, registrarFallo, reiniciarFallos } from "../ratelimit.js";
import { LIMITES, RE_CLAVE, RE_NUMERO, RE_PIN, ipCliente, leerJson } from "../base.js";

const ERROR = "Clave de empresa, número o PIN incorrectos, o acceso bloqueado temporalmente. Intenta más tarde o pide ayuda a tu administrador.";
const SAL_FICTICIA = "AAAAAAAAAAAAAAAAAAAAAA";

export async function entrarEmpleado(env, request) {
  const ip = ipCliente(request);
  const body = await leerJson(request, 1024);
  const clave = typeof body.clave === "string" ? body.clave.trim().toUpperCase() : "";
  const numero = typeof body.numero === "string" ? body.numero.trim().toUpperCase() : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  const falla = () => new HttpError(401, "acceso_denegado", ERROR);
  const claveEmp = `pin:${clave}:${numero}`;

  if (!RE_CLAVE.test(clave) || !RE_NUMERO.test(numero) || !RE_PIN.test(pin)) {
    await registrarFallo(env, `pinip:${ip}`, LIMITES.pinIp);
    throw falla();
  }
  const [bIp, bEmp] = await Promise.all([
    consultarBloqueo(env, `pinip:${ip}`, LIMITES.pinIp),
    consultarBloqueo(env, claveEmp, LIMITES.pinEmpleado),
  ]);
  if (bIp.bloqueado || bEmp.bloqueado) throw falla();

  // Búsqueda: clave → empresa → número → trabajador → hash del PIN.
  const c = await getDocument(env, `claves/${clave}`);
  const empresa = c ? await getDocument(env, `empresas/${c.empresaId}`) : null;
  const idx = empresa?.activo === true ? await getDocument(env, `empresas/${c.empresaId}/numeros/${numero}`) : null;
  const t = idx ? await getDocument(env, `empresas/${c.empresaId}/trabajadores/${idx.trabajadorId}`) : null;
  const privado = t ? await getDocument(env, `empresas/${c.empresaId}/privado/${idx.trabajadorId}`) : null;

  const calculado = await hashPin(pin, privado?.pinSal || SAL_FICTICIA, env.PIN_PEPPER, privado?.pinIter || PIN_ITERACIONES);
  const ok = !!privado && t?.activo === true && (await safeEqual(calculado, privado.pinHash));
  if (!ok) {
    await Promise.all([registrarFallo(env, claveEmp, LIMITES.pinEmpleado), registrarFallo(env, `pinip:${ip}`, LIMITES.pinIp)]);
    throw falla();
  }
  const perfil = await getDocument(env, `usuarios/${t.uid}`);
  if (!perfil || perfil.activo !== true || perfil.rol !== "trabajador" || perfil.empresaId !== c.empresaId) throw falla();

  await reiniciarFallos(env, claveEmp).catch(() => {});
  const token = await tokenPersonalizado(env, t.uid, { rol: "trabajador", empresaId: c.empresaId });
  return { token };
}
