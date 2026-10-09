// Reglas de Firestore — Fase 1: trabajadores con id propio (enlazados por uid), conteos de cobro
// y rutas solo del Worker (privado, numeros, gafetes, claves).
import { after, before, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, setLogLevel, updateDoc, where } from "firebase/firestore";

setLogLevel("silent");
let env;

const U = {
  superadmin: ["u-super", { rol: "superadmin" }, { rol: "superadmin", empresaId: "", activo: true }],
  adminA: ["u-admin-a", { rol: "admin_empresa", empresaId: "A" }, { rol: "admin_empresa", empresaId: "A", activo: true }],
  adminB: ["u-admin-b", { rol: "admin_empresa", empresaId: "B" }, { rol: "admin_empresa", empresaId: "B", activo: true }],
  supA: ["u-sup-a", { rol: "supervisor", empresaId: "A" }, { rol: "supervisor", empresaId: "A", activo: true }],
  // Uid con el formato que asigna el Worker: t-{empresa}-{trabajador}
  trabA: ["t-A-t1", { rol: "trabajador", empresaId: "A" }, { rol: "trabajador", empresaId: "A", activo: true, trabajadorId: "t1" }],
  trabA2: ["t-A-t2", { rol: "trabajador", empresaId: "A" }, { rol: "trabajador", empresaId: "A", activo: true, trabajadorId: "t2" }],
  sinClaims: ["u-nadie", {}, null],
};
const db = (k) => env.authenticatedContext(U[k][0], U[k][1]).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-horario-laboral",
    firestore: { rules: readFileSync(process.env.REGLAS || "firebase/firestore.rules", "utf8") },
  });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    for (const [uid, , perfil] of Object.values(U)) if (perfil) await setDoc(doc(f, `usuarios/${uid}`), perfil);
    for (const e of ["A", "B"]) {
      await setDoc(doc(f, `empresas/${e}`), { nombre: e, activo: true, clave: `CLAVE${e}`, empleadosActivos: 2, sitiosActivos: 1 });
      await setDoc(doc(f, `empresas/${e}/consumo/2026-10`), { maxEmpleados: 2, maxSitios: 1 });
      await setDoc(doc(f, `empresas/${e}/privado/t1`), { pinHash: "h", pinSal: "s", gafeteHash: "g" });
      await setDoc(doc(f, `empresas/${e}/numeros/G-001`), { trabajadorId: "t1" });
    }
    await setDoc(doc(f, "empresas/A/trabajadores/t1"), { uid: "t-A-t1", numero: "G-001", nombre: "Juan", activo: true });
    await setDoc(doc(f, "empresas/A/trabajadores/t2"), { uid: "t-A-t2", numero: "G-002", nombre: "Ana", activo: true });
    await setDoc(doc(f, "empresas/A/trabajadores/t3"), { uid: "", numero: "Q-003", nombre: "Solo quiosco", activo: true });
    await setDoc(doc(f, "gafetes/abc123"), { empresaId: "A", trabajadorId: "t1", activo: true });
    await setDoc(doc(f, "claves/CLAVEA"), { empresaId: "A" });
  });
});
after(async () => { await env?.cleanup(); });

describe("trabajadores con id propio", () => {
  test("el trabajador lee SU documento (por el campo uid), no el de un compañero ni el de quiosco", async () => {
    const f = db("trabA");
    await assertSucceeds(getDoc(doc(f, "empresas/A/trabajadores/t1")));
    await assertSucceeds(getDocs(query(collection(f, "empresas/A/trabajadores"), where("uid", "==", "t-A-t1"))));
    await assertFails(getDoc(doc(f, "empresas/A/trabajadores/t2")));
    await assertFails(getDoc(doc(f, "empresas/A/trabajadores/t3")));
    await assertFails(getDocs(collection(f, "empresas/A/trabajadores")));
  });
  test("admin y supervisor de A listan trabajadores de A; el admin de B no", async () => {
    await assertSucceeds(getDocs(collection(db("adminA"), "empresas/A/trabajadores")));
    await assertSucceeds(getDocs(collection(db("supA"), "empresas/A/trabajadores")));
    await assertFails(getDocs(collection(db("adminB"), "empresas/A/trabajadores")));
    await assertFails(getDoc(doc(db("adminB"), "empresas/A/trabajadores/t1")));
  });
  test("nadie escribe trabajadores desde el cliente (ni el admin)", async () => {
    await assertFails(setDoc(doc(db("adminA"), "empresas/A/trabajadores/nuevo"), { uid: "x" }));
    await assertFails(updateDoc(doc(db("adminA"), "empresas/A/trabajadores/t1"), { activo: false }));
    await assertFails(updateDoc(doc(db("trabA"), "empresas/A/trabajadores/t1"), { nombre: "Otro" }));
  });
});

describe("conteos de cobro (consumo)", () => {
  test("los lee el admin de la empresa y el superadmin", async () => {
    await assertSucceeds(getDoc(doc(db("adminA"), "empresas/A/consumo/2026-10")));
    await assertSucceeds(getDocs(collection(db("adminA"), "empresas/A/consumo")));
    await assertSucceeds(getDoc(doc(db("superadmin"), "empresas/B/consumo/2026-10")));
  });
  test("no los leen el admin de otra empresa, supervisores, trabajadores ni cuentas sin claims", async () => {
    for (const k of ["adminB", "supA", "trabA", "sinClaims"]) await assertFails(getDoc(doc(db(k), "empresas/A/consumo/2026-10")));
  });
  test("nadie los escribe desde el cliente (ni el superadmin)", async () => {
    for (const k of ["adminA", "superadmin"]) {
      await assertFails(setDoc(doc(db(k), "empresas/A/consumo/2026-10"), { maxEmpleados: 0 }));
      await assertFails(deleteDoc(doc(db(k), "empresas/A/consumo/2026-10")));
    }
  });
});

describe("rutas solo del Worker", () => {
  const rutas = ["empresas/A/privado/t1", "empresas/A/numeros/G-001", "gafetes/abc123", "claves/CLAVEA"];
  const colecciones = ["empresas/A/privado", "empresas/A/numeros", "gafetes", "claves"];
  for (const k of ["superadmin", "adminA", "supA", "trabA", "sinClaims"]) {
    test(`${k}: no lee, lista ni escribe hashes de PIN, gafetes, números ni claves`, async () => {
      const f = db(k);
      for (const r of rutas) {
        await assertFails(getDoc(doc(f, r)));
        await assertFails(setDoc(doc(f, r), { x: 1 }));
        await assertFails(deleteDoc(doc(f, r)));
      }
      for (const c of colecciones) await assertFails(getDocs(collection(f, c)));
    });
  }
});
