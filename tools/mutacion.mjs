// Pruebas de mutación: rompe a propósito una defensa a la vez y exige que alguna prueba falle.
// Si una mutación "sobrevive" (todas las pruebas pasan), hay un hueco en las pruebas.
//   node tools/mutacion.mjs worker   → mutaciones del Worker (se restaura el archivo y se verifica por hash)
//   node tools/mutacion.mjs reglas   → mutaciones de firestore.rules (sobre una COPIA en .tools/, el original no se toca)
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

const WORKER = [
  ["solo admin: se quita la verificación de rol", "worker/src/base.js", `  exigirRol(actor, "admin_empresa");\n  if (!RE_ID`, `  if (!RE_ID`],
  ["empresa inactiva sigue operando", "worker/src/base.js", `if (!empresa || empresa.activo !== true) throw`, `if (!empresa) throw`],
  ["foto: cualquier trabajador ve la de otro", "worker/src/handlers/trabajadores.js", `actor.rol === "trabajador" && actor.trabajadorId === trabajadorId`, `actor.rol === "trabajador"`],
  ["PIN: no se compara el hash", "worker/src/handlers/entrar.js", `&& (await safeEqual(calculado, privado.pinHash))`, ``],
  ["PIN: se ignora el bloqueo", "worker/src/handlers/entrar.js", `if (bIp.bloqueado || bEmp.bloqueado) throw falla();`, ``],
  ["PIN: trabajador dado de baja entra", "worker/src/handlers/entrar.js", `!!privado && t?.activo === true &&`, `!!privado &&`],
  ["alta: no se validan los sitios", "worker/src/handlers/trabajadores.js", `    await validarSitios(env, e, datos.sucursales, tx);\n    const empleadosActivos`, `    const empleadosActivos`],
  ["gafete: reimprimir no revoca el anterior", "worker/src/handlers/gafetes.js", `writes.push({ path: \`gafetes/\${privado.gafeteHash}\`, data: { activo: false`, `void ({ path: \`gafetes/\${privado.gafeteHash}\`, data: { activo: false`],
  ["cobro: no se guarda el máximo del mes", "worker/src/base.js", `maximos: { maxEmpleados: valores.empleadosActivos, maxSitios: valores.sitiosActivos },`, ``],
  ["imagen: no se verifica la firma de bytes", "worker/src/base.js", `if (!FIRMAS[tipo](bytes)) throw`, `if (false) throw`],
  ["baja: el perfil sigue activo", "worker/src/handlers/trabajadores.js", `{ path: \`usuarios/\${t.uid}\`, data: { activo }, merge: true, mustExist: true },`, ``],
  ["PIN: hash sin pepper", "worker/src/crypto.js", `importKey("raw", te.encode(pepper), { name: "HMAC"`, `importKey("raw", te.encode("constante-publica-0123456789abcdef"), { name: "HMAC"`],
  ["foto: sin consentimiento se acepta", "worker/src/handlers/trabajadores.js", `if (!t.consentimientoFoto || t.consentimientoFoto.version !== CONSENTIMIENTO_FOTO) {`, `if (false) {`],
  ["edad mínima no se valida", "worker/src/base.js", `if (edad < 15) throw`, `if (false) throw`],
];

const REGLAS = [
  ["consumo legible por cualquiera", `allow read: if adminDe(empresaId) || superadmin();`, `allow read: if true;`],
  ["trabajador lee a sus compañeros", `allow read: if staffDe(empresaId) || (trabajadorDe(empresaId) && esMio());\n        allow write: if false;\n      }\n\n      match /horarios`, `allow read: if miembroDe(empresaId);\n        allow write: if false;\n      }\n\n      match /horarios`],
  ["perfil inactivo conserva acceso", `&& p.get('activo', false) == true`, ``],
  ["claim de empresa sin comparar", `empresaClaim() == empresaId`, `empresaClaim() != ''`],
  ["rutas del Worker legibles por usuarios con sesión", `match /{document=**} {\n      allow read, write: if false;`, `match /{document=**} {\n      allow read: if autenticado();\n      allow write: if false;`],
  ["admin escribe registros", `match /registros/{registroId} {\n        allow read: if staffDe(empresaId) || (trabajadorDe(empresaId) && esMio());\n        allow create, update, delete: if false;`, `match /registros/{registroId} {\n        allow read: if staffDe(empresaId) || (trabajadorDe(empresaId) && esMio());\n        allow create, update, delete: if adminDe(empresaId);`],
  ["superadmin lee subcolecciones de la empresa", `match /sucursales/{sucursalId} {\n        allow read: if miembroDe(empresaId);`, `match /sucursales/{sucursalId} {\n        allow read: if miembroDe(empresaId) || superadmin();`],
  ["supervisor lee la bitácora", `allow read: if adminDe(empresaId);\n        allow create, update, delete: if false;\n      }\n\n      // Conteo`, `allow read: if staffDe(empresaId);\n        allow create, update, delete: if false;\n      }\n\n      // Conteo`],
];

function correr(cmd, env = {}) {
  try {
    execSync(cmd, { stdio: "pipe", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return true; // todas las pruebas pasaron
  } catch {
    return false; // alguna prueba falló
  }
}

const modo = process.argv[2];
let sobrevivientes = 0;
if (modo === "worker") {
  for (const [nombre, archivo, buscar, reemplazo] of WORKER) {
    const original = readFileSync(archivo, "utf8");
    const veces = original.split(buscar).length - 1;
    if (veces !== 1) { console.log(`ERROR  "${nombre}": el texto aparece ${veces} veces en ${archivo}`); sobrevivientes++; continue; }
    const h = sha(original);
    try {
      writeFileSync(archivo, original.replace(buscar, reemplazo));
      const pasa = correr("node --test worker/test/");
      console.log(`${pasa ? "SOBREVIVIÓ" : "detectada "}  ${nombre}`);
      if (pasa) sobrevivientes++;
    } finally {
      writeFileSync(archivo, original);
      if (sha(readFileSync(archivo, "utf8")) !== h) throw new Error(`¡${archivo} no se restauró!`);
    }
  }
} else if (modo === "reglas") {
  mkdirSync(".tools", { recursive: true });
  const original = readFileSync("firebase/firestore.rules", "utf8");
  for (const [nombre, buscar, reemplazo] of REGLAS) {
    const veces = original.split(buscar).length - 1;
    if (veces !== 1) { console.log(`ERROR  "${nombre}": el texto aparece ${veces} veces`); sobrevivientes++; continue; }
    writeFileSync(".tools/mutante.rules", original.replace(buscar, reemplazo));
    const pasa = correr("npm run -s test:rules", { REGLAS: ".tools/mutante.rules" });
    console.log(`${pasa ? "SOBREVIVIÓ" : "detectada "}  ${nombre}`);
    if (pasa) sobrevivientes++;
  }
  if (sha(readFileSync("firebase/firestore.rules", "utf8")) !== sha(original)) throw new Error("¡firestore.rules cambió!");
} else {
  console.log("Uso: node tools/mutacion.mjs worker|reglas");
  process.exit(2);
}
console.log(sobrevivientes ? `\n${sobrevivientes} mutación(es) NO detectada(s): hay que reforzar las pruebas.` : "\nTodas las mutaciones fueron detectadas por las pruebas.");
process.exit(sobrevivientes ? 1 : 0);
