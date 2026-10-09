// Sitios de trabajo (colección `sucursales`): nombre, dirección y zona permitida (centro + radio).
// Solo el admin de la empresa. El conteo de sitios activos (cobro) se actualiza en la misma transacción.
import { randomId } from "../crypto.js";
import { HttpError, conTransaccion, getDocument } from "../google.js";
import {
  TOPES, bitacora, booleano, conteos, entero, exigirAdmin, id, leerJson, numero, texto, textoOpcional,
} from "../base.js";

function datosSitio(body) {
  return {
    nombre: texto(body.nombre, "Nombre del sitio", 2, 80),
    direccion: textoOpcional(body.direccion, "Dirección", 200),
    lat: numero(body.lat, "Latitud", -90, 90),
    lng: numero(body.lng, "Longitud", -180, 180),
    radioM: entero(body.radioM, "Radio de la zona (m)", 30, 2000),
  };
}

export async function crearSitio(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const datos = datosSitio(await leerJson(request));
  const e = actor.empresaId;
  const sitioId = randomId(10);
  return conTransaccion(env, async (tx) => {
    const empresa = await getDocument(env, `empresas/${e}`, tx);
    const sitiosActivos = (empresa.sitiosActivos || 0) + 1;
    if (sitiosActivos > TOPES.sitios) throw new HttpError(409, "tope_alcanzado", `Máximo ${TOPES.sitios} sitios activos.`);
    return {
      writes: [
        { path: `empresas/${e}/sucursales/${sitioId}`, data: { ...datos, activo: true }, mustNotExist: true, serverTimeFields: ["creado", "actualizado"] },
        ...conteos(e, { empleadosActivos: empresa.empleadosActivos || 0, sitiosActivos }),
        bitacora(e, actor, "sitio_creado", { sitioId, nombre: datos.nombre }),
      ],
      resultado: { id: sitioId },
    };
  });
}

export async function editarSitio(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const sitioId = id(body.id);
  const datos = datosSitio(body);
  const e = actor.empresaId;
  return conTransaccion(env, async (tx) => {
    const sitio = await getDocument(env, `empresas/${e}/sucursales/${sitioId}`, tx);
    if (!sitio) throw new HttpError(404, "no_encontrado");
    return {
      writes: [
        { path: `empresas/${e}/sucursales/${sitioId}`, data: datos, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
        bitacora(e, actor, "sitio_editado", { sitioId, nombre: datos.nombre }),
      ],
      resultado: { id: sitioId },
    };
  });
}

export async function estadoSitio(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const sitioId = id(body.id);
  const activo = booleano(body.activo, "Activo");
  const e = actor.empresaId;
  return conTransaccion(env, async (tx) => {
    const empresa = await getDocument(env, `empresas/${e}`, tx);
    const sitio = await getDocument(env, `empresas/${e}/sucursales/${sitioId}`, tx);
    if (!sitio) throw new HttpError(404, "no_encontrado");
    if (sitio.activo === activo) return { writes: [], resultado: { id: sitioId, activo } };
    const sitiosActivos = Math.max(0, (empresa.sitiosActivos || 0) + (activo ? 1 : -1));
    if (activo && sitiosActivos > TOPES.sitios) throw new HttpError(409, "tope_alcanzado", `Máximo ${TOPES.sitios} sitios activos.`);
    return {
      writes: [
        { path: `empresas/${e}/sucursales/${sitioId}`, data: { activo }, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
        ...conteos(e, { empleadosActivos: empresa.empleadosActivos || 0, sitiosActivos }),
        bitacora(e, actor, activo ? "sitio_reactivado" : "sitio_desactivado", { sitioId }),
      ],
      resultado: { id: sitioId, activo },
    };
  });
}
