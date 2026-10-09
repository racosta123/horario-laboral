// Auditoría local de la PWA con Chrome headless (protocolo DevTools, sin dependencias).
// Requiere `node tools/serve.mjs` corriendo. Revisa: service worker activo, caché, manifest,
// violaciones de CSP, errores de consola, peticiones a otros dominios y desbordes horizontales.
// Guarda capturas en .tools/capturas/. Uso: node tools/auditar-pwa.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE || "http://localhost:5173";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUERTO = 9333;
const DIR = resolve(".tools/capturas");
mkdirSync(DIR, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${resolve(".tools/chrome-auditoria")}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const lista = await (await fetch(`http://127.0.0.1:${PUERTO}/json/list`)).json();
    const pag = lista.find((t) => t.type === "page");
    if (pag) ws = new WebSocket(pag.webSocketDebuggerUrl);
    else await esperar(200);
  } catch { await esperar(200); }
}
if (!ws) { chrome.kill(); console.error("No se pudo conectar con Chrome (¿otra auditoría abierta?)"); process.exit(2); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pendientes = new Map();
const eventos = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pendientes.has(d.id)) { pendientes.get(d.id)(d); pendientes.delete(d.id); } else eventos.push(d);
});
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pendientes.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluar = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Network.enable"); await cdp("Page.enable");
// Se instala en cada documento nuevo, antes de que corra su código.
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener("securitypolicyviolation", (e) => { try { const v = JSON.parse(sessionStorage.__csp || "[]"); v.push(e.violatedDirective + " " + e.blockedURI); sessionStorage.__csp = JSON.stringify(v); } catch {} }, true);` });

const fallas = [];
const revisar = (cond, txt) => { console.log(`${cond ? "OK   " : "FALLA"} ${txt}`); if (!cond) fallas.push(txt); };

async function abrir(ruta, ancho, alto) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: ancho, height: alto, deviceScaleFactor: 1, mobile: ancho < 600 });
  await cdp("Page.navigate", { url: BASE + ruta });
  await esperar(2500);
}
async function captura(nombre, completa = false) {
  let clip;
  if (completa) {
    const m = await cdp("Page.getLayoutMetrics");
    const { width, height } = m.result.cssContentSize;
    clip = { x: 0, y: 0, width, height: Math.min(height, 12000), scale: 1 };
  }
  const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: completa, ...(clip ? { clip } : {}) });
  writeFileSync(`${DIR}/${nombre}.png`, Buffer.from(r.result.data, "base64"));
}
const sinDesborde = () => evaluar("document.documentElement.scrollWidth <= innerWidth + 1");

// 1) App: login, service worker, caché, manifest
await abrir("/", 375, 812);
const login = await evaluar(`new Promise((ok) => { const t0 = Date.now(); (function v() { if (!document.getElementById("login").hidden) return ok(true); if (Date.now() - t0 > 10000) return ok(false); setTimeout(v, 100); })(); })`);
revisar(login, "index: se muestra el inicio de sesión (sin sesión iniciada)");
const sw = await evaluar(`navigator.serviceWorker.ready.then(r => !!r.active)`);
revisar(sw === true, "service worker activo");
await esperar(1000);
const claves = await evaluar(`caches.keys()`);
revisar(Array.isArray(claves) && claves.length === 1 && claves[0] === (await (await fetch(`${BASE}/sw.js`)).text()).match(/VERSION = "([^"]+)"/)[1], `caché de la app = versión actual de sw.js: ${JSON.stringify(claves)}`);
const enCache = await evaluar(`caches.open("${claves?.[0]}").then(c => c.keys()).then(k => k.length)`);
revisar(enCache >= 20, `archivos en caché: ${enCache}`);
const man = await evaluar(`fetch("manifest.webmanifest").then(r => r.json()).then(m => m.icons.map(i => i.sizes + ":" + i.purpose).join(","))`);
revisar(/192x192:any/.test(man) && /512x512:any/.test(man) && /512x512:maskable/.test(man), `manifest con íconos 192/512 + maskable (${man})`);
const instal = await cdp("Page.getInstallabilityErrors");
const errInst = (instal.result?.installabilityErrors || []).map((e) => e.errorId);
revisar(errInst.length === 0, `instalable según Chrome ${errInst.length ? JSON.stringify(errInst) : ""}`);
revisar(await sinDesborde(), "index 375 px sin scroll horizontal");
await captura("login-movil");
await abrir("/", 1440, 900);
await captura("login-escritorio");

// 2) Página de diseño en escritorio y celular
await abrir("/diseno.html", 1440, 900);
revisar(await sinDesborde(), "diseño 1440 px sin scroll horizontal");
await captura("diseno-escritorio", true);
await abrir("/diseno.html", 375, 812);
revisar(await sinDesborde(), "diseño 375 px sin scroll horizontal (la tabla se desliza dentro de su tarjeta)");
await captura("diseno-movil", true);
await evaluar(`document.getElementById("d-checar").click()`);
await esperar(800);
revisar(await evaluar(`!document.getElementById("d-confirmado").hidden`), "botón de checado → tarjeta «¡Registro confirmado!»");

// 3) CSP, consola y red
const csp = JSON.parse((await evaluar("sessionStorage.__csp || \"[]\"")) || "[]");
revisar(csp.length === 0, `sin violaciones de CSP ${csp.length ? JSON.stringify(csp) : ""}`);
const errores = eventos.filter((e) => (e.method === "Runtime.exceptionThrown") || (e.method === "Log.entryAdded" && e.params.entry.level === "error"))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text);
revisar(errores.length === 0, `sin errores en consola ${errores.length ? JSON.stringify(errores) : ""}`);
const externos = [...new Set(eventos.filter((e) => e.method === "Network.requestWillBeSent").map((e) => new URL(e.params.request.url))
  .filter((u) => !["localhost", "127.0.0.1"].includes(u.hostname) && u.protocol.startsWith("http")).map((u) => u.host))];
revisar(externos.length === 0, `sin peticiones a otros dominios al cargar ${externos.length ? JSON.stringify(externos) : ""}`);

// Control: la CSP de verdad bloquea un script inline y un dominio externo.
await evaluar(`document.head.append(Object.assign(document.createElement("script"), { textContent: "window.__inline = 1" })); fetch("https://ejemplo.com/x").catch(() => {}); 0`);
await esperar(500);
const bloq = JSON.parse((await evaluar("sessionStorage.__csp || \"[]\"")) || "[]");
revisar(bloq.some((v) => v.startsWith("script-src")) && bloq.some((v) => v.startsWith("connect-src")) && !(await evaluar("window.__inline")), `control: CSP bloquea script inline y conexión externa (${bloq.length} bloqueos)`);

ws.close();
const cerrado = new Promise((r) => chrome.once("exit", r));
chrome.kill();
await cerrado;
console.log(fallas.length ? `\n${fallas.length} FALLA(S)` : "\nTodo OK");
process.exit(fallas.length ? 1 : 0);
