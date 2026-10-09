// Gafetes: el QR contiene SOLO un código aleatorio opaco ("HL1" + 128 bits). En Firestore se guarda su
// SHA-256 (`gafetes/{hash}`, solo del Worker), nunca el código. Emitir uno nuevo revoca el anterior.
import { nuevoCodigoGafete, sha256Hex } from "../crypto.js";
import { HttpError, conTransaccion, getDocument } from "../google.js";
import { bitacora, exigirAdmin, id, leerJson } from "../base.js";

export async function emitirGafete(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const trabajadorId = id((await leerJson(request)).id);
  const e = actor.empresaId;
  const codigo = nuevoCodigoGafete();
  const hash = await sha256Hex(codigo);
  return conTransaccion(env, async (tx) => {
    const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`, tx);
    if (!t) throw new HttpError(404, "no_encontrado");
    if (t.activo !== true) throw new HttpError(409, "trabajador_inactivo", "El trabajador está dado de baja.");
    const privado = await getDocument(env, `empresas/${e}/privado/${trabajadorId}`, tx);
    const version = (t.gafete?.version || 0) + 1;
    const writes = [];
    if (privado?.gafeteHash) {
      writes.push({ path: `gafetes/${privado.gafeteHash}`, data: { activo: false, revocado: Date.now() }, merge: true, mustExist: true });
    }
    writes.push(
      { path: `gafetes/${hash}`, data: { empresaId: e, trabajadorId, version, activo: true, emitido: Date.now() }, mustNotExist: true },
      { path: `empresas/${e}/privado/${trabajadorId}`, data: { gafeteHash: hash }, merge: true, mustExist: true },
      { path: `empresas/${e}/trabajadores/${trabajadorId}`, data: { gafete: { estado: "activo", version, emitido: Date.now() } }, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
      bitacora(e, actor, "gafete_emitido", { trabajadorId, version, anteriorRevocado: !!privado?.gafeteHash }),
    );
    // El código se devuelve UNA vez para imprimir la credencial; después solo existe su hash.
    return { writes, resultado: { id: trabajadorId, version, codigo } };
  });
}

// Gafete perdido: deja de servir al instante. Mientras se reimprime, el trabajador checa con número + PIN.
export async function revocarGafete(env, request) {
  const { actor } = await exigirAdmin(env, request);
  const trabajadorId = id((await leerJson(request)).id);
  const e = actor.empresaId;
  return conTransaccion(env, async (tx) => {
    const t = await getDocument(env, `empresas/${e}/trabajadores/${trabajadorId}`, tx);
    if (!t) throw new HttpError(404, "no_encontrado");
    const privado = await getDocument(env, `empresas/${e}/privado/${trabajadorId}`, tx);
    if (!privado?.gafeteHash) throw new HttpError(409, "sin_gafete", "Este trabajador no tiene un gafete activo.");
    return {
      writes: [
        { path: `gafetes/${privado.gafeteHash}`, data: { activo: false, revocado: Date.now() }, merge: true, mustExist: true },
        { path: `empresas/${e}/privado/${trabajadorId}`, data: { gafeteHash: null }, merge: true, mustExist: true },
        { path: `empresas/${e}/trabajadores/${trabajadorId}`, data: { gafete: { estado: "revocado", version: t.gafete?.version || 0, revocado: Date.now() } }, merge: true, mustExist: true, serverTimeFields: ["actualizado"] },
        bitacora(e, actor, "gafete_revocado", { trabajadorId, version: t.gafete?.version || 0 }),
      ],
      resultado: { id: trabajadorId, estado: "revocado" },
    };
  });
}
