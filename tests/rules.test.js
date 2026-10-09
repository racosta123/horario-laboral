// Pruebas de las reglas de Firestore contra el emulador.
// Ejecutar con: npm run test:rules  (levanta el emulador con el JDK portátil de .tools/)
import { after, before, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, setLogLevel, updateDoc, where,
} from "firebase/firestore";

const PROJECT = "demo-horario-laboral";
const SUBCOLS = ["sucursales", "trabajadores", "horarios", "registros", "convenios", "bitacora"];
const INMUTABLES = ["registros", "bitacora", "convenios"];

let env;
setLogLevel("silent"); // los PERMISSION_DENIED esperados no ensucian la salida

// Usuarios de prueba: [uid, claims, perfil en usuarios/{uid}]
const U = {
  sinClaims: ["u-sin-claims", {}, null],
  sinClaimsConPerfil: ["u-sin-claims-perfil", {}, { rol: "admin_empresa", empresaId: "A", activo: true }],
  superadmin: ["u-super", { rol: "superadmin" }, { rol: "superadmin", empresaId: "", activo: true }],
  adminA: ["u-admin-a", { rol: "admin_empresa", empresaId: "A" }, { rol: "admin_empresa", empresaId: "A", activo: true }],
  supA: ["u-sup-a", { rol: "supervisor", empresaId: "A" }, { rol: "supervisor", empresaId: "A", activo: true }],
  trabA: ["u-trab-a", { rol: "trabajador", empresaId: "A" }, { rol: "trabajador", empresaId: "A", activo: true }],
  trabA2: ["u-trab-a2", { rol: "trabajador", empresaId: "A" }, { rol: "trabajador", empresaId: "A", activo: true }],
  trabB: ["u-trab-b", { rol: "trabajador", empresaId: "B" }, { rol: "trabajador", empresaId: "B", activo: true }],
  adminB: ["u-admin-b", { rol: "admin_empresa", empresaId: "B" }, { rol: "admin_empresa", empresaId: "B", activo: true }],
  trabInactivo: ["u-trab-inact", { rol: "trabajador", empresaId: "A" }, { rol: "trabajador", empresaId: "A", activo: false }],
  // Token con claim de empresa B pero perfil en A (claims viejos tras un cambio): sin acceso.
  trabIncongruente: ["u-trab-incong", { rol: "trabajador", empresaId: "B" }, { rol: "trabajador", empresaId: "A", activo: true }],
  rolInventado: ["u-rol-raro", { rol: "dueño", empresaId: "A" }, { rol: "dueño", empresaId: "A", activo: true }],
};

const db = (k) => env.authenticatedContext(U[k][0], U[k][1]).firestore();
const anonimo = () => env.unauthenticatedContext().firestore();

async function sembrar() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    for (const [uid, , perfil] of Object.values(U)) if (perfil) await setDoc(doc(f, `usuarios/${uid}`), perfil);
    for (const e of ["A", "B"]) {
      await setDoc(doc(f, `empresas/${e}`), { nombre: `Empresa ${e}`, activo: true });
      for (const sub of SUBCOLS) {
        // Un documento "propio" de cada trabajador y uno ajeno.
        const duenio = e === "A" ? U.trabA[0] : U.trabB[0];
        await setDoc(doc(f, `empresas/${e}/${sub}/propio`), { uid: duenio, dato: 1 });
        await setDoc(doc(f, `empresas/${e}/${sub}/ajeno`), { uid: "otro-uid", dato: 2 });
        // Documento en B que dice pertenecer al trabajador de A (no debe abrirle la puerta a B).
        if (e === "B") await setDoc(doc(f, `empresas/B/${sub}/trampa`), { uid: U.trabA[0], dato: 3 });
      }
      await setDoc(doc(f, `empresas/${e}/trabajadores/${e === "A" ? U.trabA[0] : U.trabB[0]}`), { uid: e === "A" ? U.trabA[0] : U.trabB[0], nombre: "X" });
    }
    await setDoc(doc(f, "plataforma/config"), { algo: true });
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") },
  });
});
beforeEach(async () => {
  await env.clearFirestore();
  await sembrar();
});
after(async () => { await env?.cleanup(); });

// Intenta TODAS las operaciones de lectura y escritura sobre las rutas de una empresa.
async function todoFalla(f, e) {
  await assertFails(getDoc(doc(f, `empresas/${e}`)));
  await assertFails(getDocs(collection(f, "empresas")));
  await assertFails(setDoc(doc(f, `empresas/${e}`), { nombre: "hack" }));
  for (const sub of SUBCOLS) {
    for (const id of ["propio", "ajeno"]) await assertFails(getDoc(doc(f, `empresas/${e}/${sub}/${id}`)));
    await assertFails(getDocs(collection(f, `empresas/${e}/${sub}`)));
    await assertFails(setDoc(doc(f, `empresas/${e}/${sub}/nuevo`), { uid: "x" }));
    await assertFails(updateDoc(doc(f, `empresas/${e}/${sub}/propio`), { dato: 9 }));
    await assertFails(deleteDoc(doc(f, `empresas/${e}/${sub}/propio`)));
  }
}

describe("a) cuenta sin claims (o sin sesión) no lee ni escribe nada", () => {
  test("sin sesión", async () => {
    const f = anonimo();
    await todoFalla(f, "A");
    await assertFails(getDoc(doc(f, `usuarios/${U.adminA[0]}`)));
  });
  test("autenticado sin claims (auto-registro con la apiKey pública)", async () => {
    const f = db("sinClaims");
    await todoFalla(f, "A");
    await todoFalla(f, "B");
    await assertFails(getDoc(doc(f, `usuarios/${U.sinClaims[0]}`)));
    await assertFails(setDoc(doc(f, `usuarios/${U.sinClaims[0]}`), { rol: "superadmin", activo: true }));
    await assertFails(getDocs(collection(f, "usuarios")));
    await assertFails(getDoc(doc(f, "plataforma/config")));
  });
  test("sin claims aunque exista un perfil a su nombre", async () => {
    const f = db("sinClaimsConPerfil");
    await todoFalla(f, "A");
    await assertFails(getDoc(doc(f, `usuarios/${U.sinClaimsConPerfil[0]}`)));
  });
  test("rol inventado en el claim", async () => {
    await todoFalla(db("rolInventado"), "A");
  });
  test("perfil inactivo (baja) aunque el token siga vigente", async () => {
    await todoFalla(db("trabInactivo"), "A");
  });
  test("claims incongruentes con el perfil", async () => {
    await todoFalla(db("trabIncongruente"), "A");
    await todoFalla(db("trabIncongruente"), "B");
  });
});

describe("b) aislamiento entre empresas", () => {
  test("trabajador de A no lee nada de B (ni documentos marcados con su uid)", async () => {
    const f = db("trabA");
    await todoFalla(f, "B");
    for (const sub of SUBCOLS) {
      await assertFails(getDoc(doc(f, `empresas/B/${sub}/trampa`)));
      await assertFails(getDocs(query(collection(f, `empresas/B/${sub}`), where("uid", "==", U.trabA[0]))));
    }
  });
  test("admin de A no lee nada de B", async () => {
    await todoFalla(db("adminA"), "B");
  });
  test("trabajador de B no lee nada de A", async () => {
    await todoFalla(db("trabB"), "A");
  });
  test("superadmin solo ve fichas de empresa, no datos de trabajadores", async () => {
    const f = db("superadmin");
    await assertSucceeds(getDoc(doc(f, "empresas/A")));
    await assertSucceeds(getDocs(collection(f, "empresas")));
    for (const sub of SUBCOLS) await assertFails(getDocs(collection(f, `empresas/A/${sub}`)));
    await assertFails(setDoc(doc(f, "empresas/C"), { nombre: "C" }));
  });
  test("nadie lista perfiles ni lee el perfil de otro", async () => {
    await assertFails(getDocs(collection(db("adminA"), "usuarios")));
    await assertFails(getDoc(doc(db("adminA"), `usuarios/${U.trabA[0]}`)));
    await assertFails(getDoc(doc(db("superadmin"), `usuarios/${U.trabA[0]}`)));
  });
});

describe("c) ningún cliente crea, edita ni borra registros, bitácora ni convenios", () => {
  for (const quien of ["superadmin", "adminA", "supA", "trabA"]) {
    test(`como ${quien}`, async () => {
      const f = db(quien);
      for (const sub of INMUTABLES) {
        await assertFails(setDoc(doc(f, `empresas/A/${sub}/nuevo`), { uid: U.trabA[0], ts: serverTimestamp() }));
        await assertFails(setDoc(doc(f, `empresas/A/${sub}/propio`), { uid: U.trabA[0], dato: 9 }));
        await assertFails(updateDoc(doc(f, `empresas/A/${sub}/propio`), { dato: 9 }));
        await assertFails(deleteDoc(doc(f, `empresas/A/${sub}/propio`)));
        await assertFails(deleteDoc(doc(f, `empresas/A/${sub}/ajeno`)));
      }
      // Tampoco el resto de la empresa ni los perfiles (todo se escribe desde el Worker).
      for (const sub of ["sucursales", "trabajadores", "horarios"]) {
        await assertFails(setDoc(doc(f, `empresas/A/${sub}/nuevo`), { uid: U.trabA[0] }));
      }
      await assertFails(updateDoc(doc(f, "empresas/A"), { nombre: "x" }));
      await assertFails(setDoc(doc(f, `usuarios/${U[quien][0]}`), { rol: "superadmin", empresaId: "", activo: true }));
    });
  }
});

describe("lecturas permitidas (control positivo)", () => {
  test("trabajador ve solo lo suyo en su empresa", async () => {
    const f = db("trabA");
    await assertSucceeds(getDoc(doc(f, "empresas/A")));
    await assertSucceeds(getDoc(doc(f, `usuarios/${U.trabA[0]}`)));
    await assertSucceeds(getDocs(collection(f, "empresas/A/sucursales")));
    await assertSucceeds(getDoc(doc(f, `empresas/A/trabajadores/${U.trabA[0]}`)));
    await assertFails(getDoc(doc(f, `empresas/A/trabajadores/${U.trabA2[0]}`)));
    for (const sub of ["horarios", "registros", "convenios"]) {
      await assertSucceeds(getDoc(doc(f, `empresas/A/${sub}/propio`)));
      await assertSucceeds(getDocs(query(collection(f, `empresas/A/${sub}`), where("uid", "==", U.trabA[0]))));
      await assertFails(getDoc(doc(f, `empresas/A/${sub}/ajeno`)));
      await assertFails(getDocs(collection(f, `empresas/A/${sub}`)));
    }
    await assertFails(getDocs(collection(f, "empresas/A/bitacora")));
  });
  test("otro trabajador de la misma empresa no ve lo del compañero", async () => {
    const f = db("trabA2");
    for (const sub of ["horarios", "registros", "convenios"]) await assertFails(getDoc(doc(f, `empresas/A/${sub}/propio`)));
  });
  test("admin ve toda su empresa, incluida la bitácora", async () => {
    const f = db("adminA");
    for (const sub of SUBCOLS) await assertSucceeds(getDocs(collection(f, `empresas/A/${sub}`)));
  });
  test("supervisor ve su empresa salvo la bitácora", async () => {
    const f = db("supA");
    for (const sub of SUBCOLS.filter((s) => s !== "bitacora")) await assertSucceeds(getDocs(collection(f, `empresas/A/${sub}`)));
    await assertFails(getDocs(collection(f, "empresas/A/bitacora")));
  });
});
