// Trabajadores: alta, edición, baja/reactivación, PIN y foto del alta. Solo el admin de la empresa.
// - El PIN lo genera el Worker (6 dígitos), se muestra UNA vez al admin y solo se guarda su hash
//   (con PIN_PEPPER, que vive en los secrets del Worker y nunca en Firestore).
// - El número de empleado es único por empresa e inmutable (índice `numeros/{numero}`, solo del Worker).
// - La foto solo se acepta si en el alta quedó registrado el consentimiento.
import { hashPin, nuevaSal, nuevoPin, PIN_ITERACIONES, randomId } from "../crypto.js";
import { HttpError, conTransaccion, commit, estadoCuenta, getDocument } from "../google.js";
import { reiniciarFallos } from "../ratelimit.js";
import {
  Binario, TOPES, autenticar, bitacora, booleano, conteos, exigirAdmin, fechaNacimiento, id, leerImagen, leerJson,
  numeroEmpleado, texto, bad,
} from "../base.js";

export const CONSENTIMIENTO_FOTO = "foto-alta-2026-10-v1";
const MODOS = ["telefono", "quiosco", "ambos"];
const FOTO_MAX = 400 * 1024;

const uidDe = (empresaId, trabajadorId) => `t-${empresaId}-${trabajadorId}`;

function modo(v) {
  if (!MODOS.includes(v)) throw bad("Modo de registro: teléfono, quiosco o ambos.");
  return v;
}
function listaSitios(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw bad("Asigna de 1 a 20 sitios.");
  const ids = [...new Set(v.map((x) => id(x, "Sitio")))];
  return ids;
}
// Todos los sitios deben existir, ser de la empresa y estar activos.
async function validarSitios(env, empresaId, ids, tx) {
  for (const s of ids) {
    const sitio = await getDocument(env, `empresas/${empresaId}/sucursales/${s}`, tx);
    if (!sitio || sitio.activo !== true) throw bad("Uno de los sitios no existe o está inactivo.");
  }
}

async function pinHasheado(env, pin) {
  const sal = nuevaSal();
  return { pinHash: await hashPin(pin, sal, env.PIN_PEPPER), pinSal: sal, pinIter: PIN_ITERACIONES };
}

export async function altaTrabajador(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const datos = {
    numero: numeroEmpleado(body.numero),
    nombre: texto(body.nombre, "Nombre", 1, 60),
    apellidos: texto(body.apellidos, "Apellidos", 1, 80),
    fechaNacimiento: fechaNacimiento(body.fechaNacimiento),
    sucursales: listaSitios(body.sucursales),
    modo: modo(body.modo),
  };
  const c = body.consentimientoFoto;
  if (c !== undefined && c !== null && (typeof c !== "object" || c.aceptado !== true || c.version !== CONSENTIMIENTO_FOTO)) {
    throw bad("Consentimiento de la foto: versión no válida.");
  }
  const consentimiento = c ? { version: CONSENTIMIENTO_FOTO, registradoPor: actor.uid, ts: Date.now() } : null;

  const e = actor.empresaId;
  const trabajadorId = randomId(10);
  const uid = uidDe(e, trabajadorId);
  const pin = nuevoPin();
  const secreto = await pinHasheado(env, pin);
  const nombreCompleto = `${datos.nombre} ${datos.apellidos}`;

  const resultado = await conTransaccion(env, async (tx) => {
    const empresa = await getDocument(env, `empresas/${e}`, tx);
    if (await getDocument(env, `empresas/${e}/numeros/${datos.numero}`, tx)) {
      throw new HttpError(409, "numero_existente", "Ese número de empleado ya existe en la empresa.");
    }
    await validarSitios(env, e, datos.sucursales, tx);
    const empleadosActivos = (empresa.empleadosActivos || 0) + 1;
    if (empleadosActivos > TOPES.trabajadores) throw new HttpError(409, "tope_alcanzado", `Máximo ${TOPES.trabajadores} trabajadores activos.`);
    return {
      writes: [
        {
          path: `empresas/${e}/trabajadores/${trabajadorId}`,
          data: { ...datos, uid, activo: true, consentimientoFoto: consentimiento, foto: null, gafete: { estado: "ninguno", version: 0 } },
          mustNotExist: true,
          serverTimeFields: ["creado", "actualizado"],
        },
        { path: `empresas/${e}/numeros/${datos.numero}`, data: { trabajadorId }, mustNotExist: true },
        { path: `empresas/${e}/privado/${trabajadorId}`, data: { ...secreto, gafeteHash: null }, mustNotExist: true },
        { path: `usuarios/${uid}`, data: { rol: "trabajador", empresaId: e, nombre: nombreCompleto, trabajadorId, activo: true }, mustNotExist: true, serverTimeFields: ["creado"] },
        ...conteos(e, { empleadosActivos, sitiosActivos: empresa.sitiosActivos || 0 }),
        bitacora(e, actor, "trabajador_alta", { trabajadorId, numero: datos.numero, consentimientoFoto: !!consentimiento }),
      ],
      resultado: { id: trabajadorId, uid },
    };
  });
  // El PIN se devuelve UNA sola vez para entregarlo al trabajador; no se puede volver a consultar.
  return { ...resultado, pin };
}

export async function editarTrabajador(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const trabajadorId = id(body.id);
  const datos = {
    nombre: texto(body.nombre, "Nombre", 1, 60),
    apellidos: texto(body.apellidos, "Apellidos", 1, 80),
    fechaNacimiento: fechaNacimiento(body.fechaNacimiento),
    sucursales: listaSitios(body.sucursales),
    modo: modo(body.modo),
  };
  if (body.numero !== undefined) throw bad("El número de empleado no se puede cambiar.");
  const e = actor.empresaId;
  return conTransaccion(env, async (tx) => {
    const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`, tx);
    if (!t) throw new HttpError(404, "no_encontrado");
    await validarSitios(env, e, datos.sucursales, tx);
    return {
      writes: [
        { path: `empresas/${e}/trabajadores/${trabajadorId}`, data: datos, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
        { path: `usuarios/${t.uid}`, data: { nombre: `${datos.nombre} ${datos.apellidos}` }, merge: true, mustExist: true },
        bitacora(e, actor, "trabajador_editado", { trabajadorId }),
      ],
      resultado: { id: trabajadorId },
    };
  });
}

// Baja: desactiva al trabajador y su perfil, revoca su gafete y su sesión. Reactivar no revive el gafete.
export async function estadoTrabajador(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const trabajadorId = id(body.id);
  const activo = booleano(body.activo, "Activo");
  const e = actor.empresaId;
  const r = await conTransaccion(env, async (tx) => {
    const empresa = await getDocument(env, `empresas/${e}`, tx);
    const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`, tx);
    if (!t) throw new HttpError(404, "no_encontrado");
    if (t.activo === activo) return { writes: [], resultado: { id: trabajadorId, activo, uid: t.uid, cambio: false } };
    const privado = await getDocument(env, `empresas/${e}/privado/${trabajadorId}`, tx);
    const empleadosActivos = Math.max(0, (empresa.empleadosActivos || 0) + (activo ? 1 : -1));
    if (activo && empleadosActivos > TOPES.trabajadores) throw new HttpError(409, "tope_alcanzado", `Máximo ${TOPES.trabajadores} trabajadores activos.`);
    const revocarGafete = !activo && !!privado?.gafeteHash;
    const cambios = { activo, ...(revocarGafete ? { gafete: { estado: "revocado", version: t.gafete?.version || 0 } } : {}) };
    const writes = [
      { path: `empresas/${e}/trabajadores/${trabajadorId}`, data: cambios, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
      { path: `usuarios/${t.uid}`, data: { activo }, merge: true, mustExist: true },
      ...conteos(e, { empleadosActivos, sitiosActivos: empresa.sitiosActivos || 0 }),
    ];
    if (revocarGafete) {
      writes.push(
        { path: `gafetes/${privado.gafeteHash}`, data: { activo: false, revocado: Date.now() }, merge: true, mustExist: true },
        { path: `empresas/${e}/privado/${trabajadorId}`, data: { gafeteHash: null }, merge: true, mustExist: true },
      );
    }
    writes.push(bitacora(e, actor, activo ? "trabajador_reactivado" : "trabajador_baja", { trabajadorId }));
    return { writes, resultado: { id: trabajadorId, activo, uid: t.uid, cambio: true } };
  });
  // Sesión de Firebase: inhabilitar (y revocar) o habilitar. Si nunca entró, no existe la cuenta.
  if (r.cambio) await estadoCuenta(env, r.uid, { activa: activo }).catch(() => {});
  return { id: r.id, activo: r.activo };
}

// PIN nuevo (el anterior deja de servir) y se quita el bloqueo por intentos fallidos de ese empleado.
export async function restablecerPin(env, request) {
  const { actor, empresa } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const trabajadorId = id(body.id);
  const e = actor.empresaId;
  const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`);
  if (!t) throw new HttpError(404, "no_encontrado");
  const pin = nuevoPin();
  await commit(env, [
    { path: `empresas/${e}/privado/${trabajadorId}`, data: await pinHasheado(env, pin), merge: true, mustExist: true },
    bitacora(e, actor, "trabajador_pin_restablecido", { trabajadorId }),
  ]);
  await reiniciarFallos(env, `pin:${empresa.clave}:${t.numero}`).catch(() => {});
  return { id: trabajadorId, pin };
}

// ---- Foto del alta (R2 privado) -------------------------------------------
export async function subirFoto(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const trabajadorId = id(new URL(request.url).searchParams.get("id"));
  const e = actor.empresaId;
  const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`);
  if (!t) throw new HttpError(404, "no_encontrado");
  if (!t.consentimientoFoto || t.consentimientoFoto.version !== CONSENTIMIENTO_FOTO) {
    throw new HttpError(409, "sin_consentimiento", "Primero registra el consentimiento del trabajador para la foto.");
  }
  const { bytes, tipo } = await leerImagen(request, ["image/jpeg"], FOTO_MAX);
  const fotoId = randomId(8);
  const clave = `empresas/${e}/fotos/${trabajadorId}/${fotoId}.jpg`;
  await env.EVIDENCIAS.put(clave, bytes, { httpMetadata: { contentType: tipo } });
  try {
    await commit(env, [
      { path: `empresas/${e}/trabajadores/${trabajadorId}`, data: { foto: { id: fotoId, bytes: bytes.length, ts: Date.now() } }, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
      bitacora(e, actor, "trabajador_foto", { trabajadorId, bytes: bytes.length }),
    ]);
  } catch (err) {
    await env.EVIDENCIAS.delete(clave).catch(() => {});
    throw err;
  }
  if (t.foto?.id) await env.EVIDENCIAS.delete(`empresas/${e}/fotos/${trabajadorId}/${t.foto.id}.jpg`).catch(() => {});
  return { id: trabajadorId, foto: fotoId };
}

// La foto la ven: el admin de la empresa y el propio trabajador. Nadie más (ni supervisores ni superadmin).
export async function verFoto(env, request) {
  const actor = await autenticar(env, request);
  const trabajadorId = id(new URL(request.url).searchParams.get("id"));
  const esAdmin = actor.rol === "admin_empresa";
  const esElMismo = actor.rol === "trabajador" && actor.trabajadorId === trabajadorId;
  if (!esAdmin && !esElMismo) throw new HttpError(403, "sin_acceso");
  const t = await getDocument(env, `empresas/${actor.empresaId}/trabajadores/${trabajadorId}`);
  if (!t || !t.foto?.id) throw new HttpError(404, "no_encontrado");
  if (esElMismo && t.uid !== actor.uid) throw new HttpError(403, "sin_acceso");
  const obj = await env.EVIDENCIAS.get(`empresas/${actor.empresaId}/fotos/${trabajadorId}/${t.foto.id}.jpg`);
  if (!obj) throw new HttpError(404, "no_encontrado");
  return new Binario(obj.body, "image/jpeg");
}
