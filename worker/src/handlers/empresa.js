// Configuración de la empresa (solo su admin): colores y logo de la credencial, y si el gafete exige PIN.
import { randomId } from "../crypto.js";
import { HttpError, commit, getDocument } from "../google.js";
import { Binario, autenticar, bitacora, booleano, color, exigirAdmin, leerImagen, leerJson } from "../base.js";

const LOGO_MAX = 200 * 1024;

export async function guardarMarca(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const marca = { colorPrimario: color(body.colorPrimario, "Color principal"), colorSecundario: color(body.colorSecundario, "Color secundario") };
  const e = actor.empresaId;
  await commit(env, [
    { path: `empresas/${e}`, data: { marca }, merge: true, mustExist: true },
    bitacora(e, actor, "marca_actualizada", marca),
  ]);
  return { marca };
}

export async function guardarConfig(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const body = await leerJson(request);
  const config = { pinConGafete: booleano(body.pinConGafete, "Pedir PIN además del gafete") };
  const e = actor.empresaId;
  await commit(env, [
    { path: `empresas/${e}`, data: { config }, merge: true, mustExist: true },
    bitacora(e, actor, "config_actualizada", config),
  ]);
  return { config };
}

export async function subirLogo(env, request) {
  const { actor, empresa } = await exigirAdmin(env, request);
  const { bytes, tipo } = await leerImagen(request, ["image/png", "image/jpeg"], LOGO_MAX);
  const e = actor.empresaId;
  const logoId = randomId(8);
  const clave = `empresas/${e}/logo/${logoId}`;
  await env.EVIDENCIAS.put(clave, bytes, { httpMetadata: { contentType: tipo } });
  try {
    await commit(env, [
      { path: `empresas/${e}`, data: { logo: { id: logoId, tipo, bytes: bytes.length } }, merge: true, mustExist: true },
      bitacora(e, actor, "logo_actualizado", { tipo, bytes: bytes.length }),
    ]);
  } catch (err) {
    await env.EVIDENCIAS.delete(clave).catch(() => {});
    throw err;
  }
  if (empresa.logo?.id) await env.EVIDENCIAS.delete(`empresas/${e}/logo/${empresa.logo.id}`).catch(() => {});
  return { logo: logoId };
}

// El logo lo ve cualquier miembro activo de la empresa (no es dato personal).
export async function verLogo(env, request) {
  const actor = await autenticar(env, request);
  if (!actor.empresaId) throw new HttpError(403, "sin_acceso");
  const empresa = await getDocument(env, `empresas/${actor.empresaId}`);
  if (!empresa?.logo?.id) throw new HttpError(404, "no_encontrado");
  const obj = await env.EVIDENCIAS.get(`empresas/${actor.empresaId}/logo/${empresa.logo.id}`);
  if (!obj) throw new HttpError(404, "no_encontrado");
  return new Binario(obj.body, empresa.logo.tipo === "image/png" ? "image/png" : "image/jpeg");
}
