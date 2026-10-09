// Lecturas de Firestore desde el navegador (Firestore Lite). Las reglas deciden qué puede ver cada quien:
// el admin solo su empresa, el trabajador solo lo suyo. NUNCA se escribe desde aquí (todo va por el Worker).
import { collection, doc, getDoc, getDocs, getFirestore, query, where } from "./vendor/firebase.js";
import { app } from "./auth.js";

const db = getFirestore(app);
const plano = (s) => ({ id: s.id, ...s.data() });
const porNombre = (a, b) => `${a.nombre} ${a.apellidos || ""}`.localeCompare(`${b.nombre} ${b.apellidos || ""}`, "es");

export async function empresa(empresaId) {
  const s = await getDoc(doc(db, "empresas", empresaId));
  return s.exists() ? plano(s) : null;
}

export async function sitios(empresaId) {
  const s = await getDocs(collection(db, "empresas", empresaId, "sucursales"));
  return s.docs.map(plano).sort(porNombre);
}

export async function sitio(empresaId, id) {
  const s = await getDoc(doc(db, "empresas", empresaId, "sucursales", id));
  return s.exists() ? plano(s) : null;
}

export async function trabajadores(empresaId) {
  const s = await getDocs(collection(db, "empresas", empresaId, "trabajadores"));
  return s.docs.map(plano).sort(porNombre);
}

export async function trabajador(empresaId, id) {
  const s = await getDoc(doc(db, "empresas", empresaId, "trabajadores", id));
  return s.exists() ? plano(s) : null;
}

// El trabajador solo puede consultar su propio documento (filtro por su uid, como exigen las reglas).
export async function miFicha(empresaId, uid) {
  const s = await getDocs(query(collection(db, "empresas", empresaId, "trabajadores"), where("uid", "==", uid)));
  return s.docs.length ? plano(s.docs[0]) : null;
}

export async function consumo(empresaId, mes) {
  const s = await getDoc(doc(db, "empresas", empresaId, "consumo", mes));
  return s.exists() ? plano(s) : null;
}
