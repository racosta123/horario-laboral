// Sesión con Firebase Auth (email/contraseña). El SDK vive dentro del repo (js/vendor/firebase.js).
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut,
} from "./vendor/firebase.js";
import { FIREBASE_CONFIG } from "./config.js";

const app = initializeApp(FIREBASE_CONFIG);
// Sin popupRedirectResolver: no se cargan scripts ni iframes externos.
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
auth.languageCode = "es";

export const ROLES = ["superadmin", "admin_empresa", "supervisor", "trabajador"];

export const entrar = (email, password) => signInWithEmailAndPassword(auth, email.trim(), password);
export const salir = () => signOut(auth);
export const restablecer = (email) => sendPasswordResetEmail(auth, email.trim());
export const alCambiarSesion = (fn) => onAuthStateChanged(auth, fn);

// Rol según los custom claims (solo los asigna el Worker). Sin rol válido → null.
export async function rolActual(forzar = false) {
  const u = auth.currentUser;
  if (!u) return null;
  const r = await u.getIdTokenResult(forzar);
  return ROLES.includes(r.claims.rol) ? r.claims.rol : null;
}

export async function idToken() {
  const u = auth.currentUser;
  if (!u) throw new Error("sin_sesion");
  return u.getIdToken();
}

// Mensajes de error de inicio de sesión (genéricos: no revelan si el correo existe).
export function mensajeError(e) {
  const c = e?.code || "";
  if (c === "auth/too-many-requests") return "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
  if (c === "auth/network-request-failed") return "Sin conexión. Revisa tu internet e inténtalo de nuevo.";
  if (c === "auth/user-disabled") return "Tu cuenta está desactivada. Habla con tu administrador.";
  return "Correo o contraseña incorrectos.";
}
