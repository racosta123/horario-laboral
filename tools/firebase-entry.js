// Entrada del bundle: SOLO lo que la app usa del SDK de Firebase.
// - Auth: correo/contraseña (admins) y token personalizado (empleados con número + PIN, emitido por el Worker).
//   initializeAuth SIN popupRedirectResolver: el SDK no carga scripts ni iframes de apis.google.com.
// - Firestore Lite: SOLO lecturas protegidas por las reglas (sin tiempo real ni caché local). Las escrituras van por el Worker.
export { initializeApp } from "firebase/app";
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signInWithCustomToken, sendPasswordResetEmail, onAuthStateChanged, signOut,
} from "firebase/auth";
export {
  getFirestore, doc, getDoc, collection, getDocs, query, where, orderBy, limit,
} from "firebase/firestore/lite";
