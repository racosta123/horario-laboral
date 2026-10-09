// Plataforma: perfil propio, alta de empresas (superadmin) y alta única del superadmin.
import { nuevaClaveEmpresa, randomId, randomPassword, safeEqual } from "../crypto.js";
import { HttpError, borrarCuenta, commit, crearCuenta, enviarCorreoContrasena, getDocument } from "../google.js";
import {
  LIMITES, autenticar, bitacora, conteos, correo, exigirRol, ipCliente, leerJson, limitar, rfc, texto,
} from "../base.js";

export async function yo(env, request) {
  const a = await autenticar(env, request);
  let empresa = null;
  if (a.empresaId) {
    const e = await getDocument(env, `empresas/${a.empresaId}`);
    if (e) empresa = { id: a.empresaId, nombre: e.nombre };
  }
  return { uid: a.uid, rol: a.rol, nombre: a.nombre, empresa, trabajadorId: a.trabajadorId || undefined };
}

// Alta de empresa + su primer admin_empresa (solo superadmin).
// La empresa nace con su clave para el acceso de empleados, sus conteos de cobro en cero y su marca por defecto.
export async function crearEmpresa(env, request) {
  const actor = await autenticar(env, request);
  exigirRol(actor, "superadmin");
  await limitar(env, `crear:${actor.uid}`, LIMITES.crearEmpresa);
  const body = await leerJson(request);
  const nombre = texto(body.nombre, "Nombre de la empresa", 2, 120);
  const rfcEmpresa = rfc(body.rfc);
  const admin = body.admin && typeof body.admin === "object" ? body.admin : {};
  const adminNombre = texto(admin.nombre, "Nombre del administrador", 2, 80);
  const adminEmail = correo(admin.email);

  const empresaId = randomId(10);
  const claims = { rol: "admin_empresa", empresaId };
  const uid = await crearCuenta(env, { email: adminEmail, password: randomPassword(), displayName: adminNombre, claims });
  let clave;
  try {
    // La clave es única: si ya existe (muy improbable) se intenta otra.
    for (let i = 0; ; i++) {
      clave = nuevaClaveEmpresa();
      try {
        await commit(env, [
          {
            path: `empresas/${empresaId}`,
            data: {
              nombre, rfc: rfcEmpresa, activo: true, creadaPor: actor.uid, clave,
              plan: "prueba", estadoCobro: "prueba", empleadosActivos: 0, sitiosActivos: 0,
              marca: { colorPrimario: "#0F9D94", colorSecundario: "#183153" },
              config: { pinConGafete: false },
            },
            mustNotExist: true,
            serverTimeFields: ["creada"],
          },
          { path: `claves/${clave}`, data: { empresaId }, mustNotExist: true },
          ...conteos(empresaId, { empleadosActivos: 0, sitiosActivos: 0 }).slice(1),
          {
            path: `usuarios/${uid}`,
            data: { rol: "admin_empresa", empresaId, nombre: adminNombre, activo: true },
            mustNotExist: true,
            serverTimeFields: ["creado"],
          },
          bitacora(empresaId, actor, "empresa_creada", { nombre, adminUid: uid }),
        ]);
        break;
      } catch (e) {
        if (!(e instanceof HttpError && e.code === "ya_existe") || i >= 4) throw e;
      }
    }
  } catch (e) {
    await borrarCuenta(env, uid).catch(() => {});
    throw e;
  }
  const correoEnviado = await enviarCorreoContrasena(env, adminEmail).catch(() => false);
  return { empresaId, adminUid: uid, clave, correoEnviado };
}

// Alta ÚNICA del superadmin. Requiere el secret SETUP_TOKEN y solo funciona mientras no exista uno.
// Después de usarlo: `wrangler secret delete SETUP_TOKEN`.
export async function setupSuperadmin(env, request) {
  await limitar(env, `setup:${ipCliente(request)}`, LIMITES.setup);
  const esperado = env.SETUP_TOKEN || "";
  const dado = (/^Bearer (.+)$/.exec(request.headers.get("authorization") || "") || [])[1] || "";
  if (esperado.length < 32 || !(await safeEqual(dado, esperado))) throw new HttpError(404, "no_encontrado");
  if (await getDocument(env, "plataforma/superadmin")) throw new HttpError(409, "ya_existe");
  const body = await leerJson(request);
  const nombre = texto(body.nombre, "Nombre", 2, 80);
  const email = correo(body.email);
  const uid = await crearCuenta(env, { email, password: randomPassword(), displayName: nombre, claims: { rol: "superadmin" } });
  try {
    await commit(env, [
      { path: "plataforma/superadmin", data: { uid }, mustNotExist: true, serverTimeFields: ["creado"] },
      { path: `usuarios/${uid}`, data: { rol: "superadmin", empresaId: "", nombre, activo: true }, mustNotExist: true, serverTimeFields: ["creado"] },
    ]);
  } catch (e) {
    await borrarCuenta(env, uid).catch(() => {});
    throw e;
  }
  const correoEnviado = await enviarCorreoContrasena(env, email).catch(() => false);
  return { uid, correoEnviado };
}
