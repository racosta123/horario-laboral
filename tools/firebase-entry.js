// Entrada del bundle: SOLO lo que la app usa del SDK de Firebase (Auth con email/contraseña).
// initializeAuth SIN popupRedirectResolver: el SDK no carga scripts ni iframes de apis.google.com.
export { initializeApp } from "firebase/app";
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut,
} from "firebase/auth";
