// Comprueba, SIN credenciales, que la apiKey web de Firebase (js/config.js) sigue restringida por dominio.
// Uso manual: npm run verify:apikey   (no va en el hook de commit: necesita red).
// Llama a accounts:createAuthUri (pública, no inicia sesión ni crea cuentas) con distintos Referer:
//   - desde un dominio NO permitido (evil.example) debe responder 403 API_KEY_HTTP_REFERRER_BLOCKED;
//   - desde el dominio publicado debe funcionar (si no, la llave se borró o se restringió de más).
import { readFileSync } from "node:fs";

const llave = (readFileSync("js/config.js", "utf8").match(/AIza[0-9A-Za-z_-]{35}/) || [])[0];
if (!llave) { console.error("No se encontró la apiKey en js/config.js"); process.exit(2); }

async function intentar(referer) {
  const headers = { "content-type": "application/json" };
  if (referer) headers.referer = referer;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${llave}`, {
    method: "POST", headers,
    body: JSON.stringify({ identifier: "verificacion@example.com", continueUri: "https://racosta123.github.io/horario-laboral/" }),
  });
  const j = await r.json().catch(() => ({}));
  const razon = (j?.error?.details || []).map((d) => d.reason).find(Boolean) || j?.error?.status || "";
  return { status: r.status, razon };
}

let malo = false;
for (const ref of ["https://evil.example/", null]) {
  const r = await intentar(ref);
  const bloqueada = r.status === 403 && r.razon === "API_KEY_HTTP_REFERRER_BLOCKED";
  console.log(`${bloqueada ? "OK   " : "ALERTA"} Referer ${ref ?? "(ninguno)"} → ${r.status} ${r.razon}`);
  if (!bloqueada) malo = true;
}
const ok = await intentar("https://racosta123.github.io/horario-laboral/");
const funciona = ok.status === 200;
console.log(`${funciona ? "OK   " : "AVISO"} Referer https://racosta123.github.io/horario-laboral/ → ${ok.status} ${ok.razon}`);

if (malo) {
  console.error("\n*** ALERTA: LA RESTRICCIÓN POR DOMINIO DE LA apiKey SE PERDIÓ. ***");
  console.error("Cualquier sitio puede usar la llave. Restablécela en Google Cloud → APIs y servicios → Credenciales");
  console.error("(dominios: racosta123.github.io, horario-laboral-d14.firebaseapp.com y localhost).");
  process.exit(1);
}
if (!funciona) {
  console.error("\nAVISO: la restricción sigue, pero la app publicada no puede usar la llave (¿se borró o se restringió de más?).");
  process.exit(1);
}
console.log("\nLa apiKey sigue restringida por dominio y la app publicada puede usarla.");
