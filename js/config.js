// Configuración PÚBLICA de la app web.
// La apiKey web de Firebase NO es un secreto: identifica al proyecto y viaja en cada petición del navegador.
// La seguridad la dan las reglas de Firestore, los custom claims y el Worker. (Se recomienda restringirla
// por dominio en Google Cloud → Credenciales.)
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCc-tDVq_0tOSPOo3NP0XxdHuVY2jvtL00",
  authDomain: "horario-laboral-d14.firebaseapp.com",
  projectId: "horario-laboral-d14",
  appId: "1:190510757127:web:c3d8e7f6971bb2d44c41a2",
};

// En desarrollo (tools/serve.mjs en localhost) se usa el Worker local de "wrangler dev".
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
export const WORKER_URL = LOCAL ? "http://127.0.0.1:8787" : "https://horario-laboral-proxy.acosta4770.workers.dev";
