// Prueba de punta a punta LOCAL, sin nube: la PWA real en Chrome headless + el código REAL del Worker
// (worker/src) ejecutándose aquí con Google simulado en memoria (worker/test/harness.js).
//   - Las llamadas del navegador al Worker, a Firebase Auth y a Firestore se interceptan (protocolo DevTools)
//     y se responden desde este proceso. Nada sale a internet.
//   - Datos y contraseñas de prueba ficticios, generados en cada corrida.
// Uso: node tools/e2e-local.mjs   (deja capturas en .tools/capturas/e2e-*.png)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PUERTO_WEB = 5173;
const ORIGEN = `http://localhost:${PUERTO_WEB}`;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIR = resolve(".tools/capturas");
mkdirSync(DIR, { recursive: true });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchReal = globalThis.fetch;

// ---------- servidor estático y Chrome ----------
const web = spawn(process.execPath, ["tools/serve.mjs"], { stdio: "ignore" });
const PUERTO = 9300 + Math.floor(Math.random() * 600);
const PERFIL = mkdtempSync(resolve(".tools/chrome-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${PERFIL}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try { const l = await (await fetchReal(`http://127.0.0.1:${PUERTO}/json/list`)).json(); const p = l.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await esperar(200); } catch { await esperar(200); }
}
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
for (let i = 0; i < 50; i++) { try { await fetchReal(`${ORIGEN}/`); break; } catch { await esperar(200); } }

// ---------- backend simulado: Worker real + Google en memoria ----------
const { crearMundo } = await import("../worker/test/harness.js");
const m = await crearMundo(); // reemplaza globalThis.fetch por el Google simulado
m.env.DEV_ORIGINS = ORIGEN;
const P = "hl-test";
const BASE_DOCS = `projects/${P}/databases/(default)/documents`;
m.poner("usuarios/super", { rol: "superadmin", empresaId: "", nombre: "Diagonal", activo: true });
const tokSuper = await m.token("super", { rol: "superadmin" });
const alta = await m.pedir("POST", "/v1/empresas", { token: tokSuper, body: { nombre: "PRUEBA Seguridad Kino", admin: { nombre: "Rubén Prueba", email: "admin@prueba.local" } } });
if (alta.status !== 200) throw new Error(`no se creó la empresa de prueba: ${JSON.stringify(alta.body)}`);
const EMPRESA = alta.body;
const PASS_ADMIN = `prueba-${Math.random().toString(36).slice(2)}`; // contraseña ficticia de esta corrida
m.cuentas.get(EMPRESA.adminUid).password = PASS_ADMIN;
const claimsDe = (uid) => {
  const p = m.leer(`usuarios/${uid}`);
  return p ? { rol: p.rol, ...(p.empresaId ? { empresaId: p.empresaId } : {}) } : {};
};
const refreshes = new Map(); // refreshToken -> uid

// Respuestas en formato de Firestore REST para Firestore Lite.
// Los nombres se devuelven con el proyecto que pidió la app (el simulador guarda todo bajo hl-test).
let baseApp = BASE_DOCS;
const docRest = (ruta) => {
  const f = m.docs.get(`${BASE_DOCS}/${ruta}`);
  return f ? { name: `${baseApp}/${ruta}`, fields: f, createTime: "2026-10-09T00:00:00Z", updateTime: "2026-10-09T00:00:00Z" } : null;
};
function firestore(url, cuerpo) {
  const u = new URL(url);
  baseApp = (decodeURIComponent(u.pathname).match(/^\/v1\/(projects\/[^/]+\/databases\/\(default\)\/documents)/) || [])[1] || BASE_DOCS;
  const ruta = decodeURIComponent(u.pathname).replace(/^\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents/, "").replace(/^\//, "");
  const ahora = new Date().toISOString();
  if (ruta.endsWith(":batchGet") || u.pathname.endsWith(":batchGet")) {
    return cuerpo.documents.map((n) => {
      const r = n.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, "");
      const d = docRest(r);
      return d ? { found: d, readTime: ahora } : { missing: n, readTime: ahora };
    });
  }
  if (ruta.endsWith(":runQuery")) {
    const padre = ruta.replace(/:runQuery$/, "");
    const q = cuerpo.structuredQuery;
    const col = q.from[0].collectionId;
    const prefijo = `${padre ? `${padre}/` : ""}${col}/`;
    let lista = m.rutas(prefijo).filter((k) => !k.slice(prefijo.length).includes("/"));
    const ff = q.where?.fieldFilter;
    if (ff) lista = lista.filter((k) => JSON.stringify(m.docs.get(`${BASE_DOCS}/${k}`)[ff.field.fieldPath]) === JSON.stringify(ff.value));
    return lista.length ? lista.map((k) => ({ document: docRest(k), readTime: ahora })) : [{ readTime: ahora }];
  }
  throw new Error(`Firestore: operación no simulada ${url}`);
}

function auth(url, cuerpo) {
  const u = new URL(url);
  const op = u.pathname.split("/").pop();
  const emitir = async (uid) => {
    const refreshToken = `rt-${Math.random().toString(36).slice(2)}`;
    refreshes.set(refreshToken, uid);
    return { idToken: await m.token(uid, claimsDe(uid)), refreshToken, expiresIn: "3600", localId: uid };
  };
  if (op === "accounts:signInWithPassword") {
    const par = [...m.cuentas.entries()].find(([, c]) => c.email === cuerpo.email);
    if (!par || par[1].password !== cuerpo.password) return { status: 400, cuerpo: { error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" } } };
    return emitir(par[0]).then((r) => ({ ...r, email: cuerpo.email, registered: true }));
  }
  if (op === "accounts:signInWithCustomToken") {
    return m.verificarTokenPersonalizado(cuerpo.token).then((p) => (p ? emitir(p.uid).then((r) => ({ ...r, isNewUser: false })) : { status: 400, cuerpo: { error: { code: 400, message: "INVALID_CUSTOM_TOKEN" } } }));
  }
  if (op === "accounts:lookup") {
    const t = JSON.parse(Buffer.from(cuerpo.idToken.split(".")[1], "base64url").toString());
    return { users: [{ localId: t.sub, email: m.cuentas.get(t.sub)?.email, emailVerified: true, providerUserInfo: [], createdAt: "1", lastLoginAt: String(Date.now()) }] };
  }
  if (op === "token") { // securetoken: renovar
    const uid = refreshes.get(new URLSearchParams(cuerpo).get("refresh_token"));
    if (!uid) return { status: 400, cuerpo: { error: { message: "INVALID_REFRESH_TOKEN" } } };
    return m.token(uid, claimsDe(uid)).then((id) => ({ id_token: id, access_token: id, refresh_token: new URLSearchParams(cuerpo).get("refresh_token"), expires_in: "3600", user_id: uid, project_id: P, token_type: "Bearer" }));
  }
  if (op === "accounts:sendOobCode") return { email: cuerpo.email };
  throw new Error(`Auth: operación no simulada ${url}`);
}

// ---------- protocolo DevTools ----------
let id = 0;
const pend = new Map();
const eventos = [];
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluar = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(`evaluar: ${r.result.exceptionDetails.exception?.description || e}`);
  return r.result?.result?.value;
};
const cors = [
  { name: "access-control-allow-origin", value: ORIGEN }, { name: "access-control-allow-headers", value: "*" },
  { name: "access-control-allow-methods", value: "GET, POST, OPTIONS" }, { name: "content-type", value: "application/json" },
];
const responder = (requestId, status, obj, headers = cors) => cdp("Fetch.fulfillRequest", {
  requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64"),
});
const interceptados = [];
let archivoParaSubir = null;

ws.addEventListener("message", async (msg) => {
  const d = JSON.parse(msg.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  eventos.push(d);
  if (d.method === "Page.javascriptDialogOpening") { await cdp("Page.handleJavaScriptDialog", { accept: true }); return; }
  if (d.method === "Page.fileChooserOpened") {
    await cdp("DOM.setFileInputFiles", { files: [archivoParaSubir], backendNodeId: d.params.backendNodeId });
    return;
  }
  if (d.method !== "Fetch.requestPaused") return;
  const { requestId, request } = d.params;
  const u = new URL(request.url);
  interceptados.push(`${request.method} ${u.host}${u.pathname}`);
  try {
    if (request.method === "OPTIONS") return responder(requestId, 204, "");
    const bytes = request.postDataEntries?.length ? Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64"))) : null;
    const texto = bytes ? bytes.toString("utf8") : request.postData || "";
    if (u.host === "127.0.0.1:8787") {
      // Worker REAL con el Google simulado.
      const headers = { ...request.headers, "cf-connecting-ip": "10.9.9.9" };
      const init = { method: request.method, headers };
      if (bytes) init.body = bytes;
      const res = await (await import("../worker/src/index.js")).default.fetch(new Request(`https://proxy.local${u.pathname}${u.search}`, init), m.env);
      const cuerpo = Buffer.from(await res.arrayBuffer());
      return cdp("Fetch.fulfillRequest", {
        requestId, responseCode: res.status, body: cuerpo.toString("base64"),
        responseHeaders: [...res.headers.entries()].map(([name, value]) => ({ name, value })),
      });
    }
    if (u.host === "firestore.googleapis.com") return responder(requestId, 200, firestore(request.url, JSON.parse(texto || "{}")));
    if (u.host === "identitytoolkit.googleapis.com" || u.host === "securetoken.googleapis.com") {
      const r = await auth(request.url, u.host === "securetoken.googleapis.com" ? texto : JSON.parse(texto || "{}"));
      return r?.status ? responder(requestId, r.status, r.cuerpo) : responder(requestId, 200, r);
    }
    return cdp("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  } catch (e) {
    console.error("intercepción:", e.message);
    return responder(requestId, 500, { error: "simulacion" });
  }
});

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Log.enable");
await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
await cdp("Fetch.enable", { patterns: [
  { urlPattern: "http://127.0.0.1:8787/*" }, { urlPattern: "https://firestore.googleapis.com/*" },
  { urlPattern: "https://identitytoolkit.googleapis.com/*" }, { urlPattern: "https://securetoken.googleapis.com/*" },
] });
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener("securitypolicyviolation", (e) => { try { const v = JSON.parse(sessionStorage.__csp || "[]"); v.push(e.violatedDirective + " " + e.blockedURI); sessionStorage.__csp = JSON.stringify(v); } catch {} }, true);` });

// ---------- utilidades de la prueba ----------
let fallas = 0;
const revisar = (cond, txt) => { console.log(`${cond ? "OK   " : "FALLA"} ${txt}`); if (!cond) fallas++; };
async function hasta(expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluar(expr).catch(() => false)) return true; await esperar(150); }
  return false;
}
const escribir = (sel, v) => evaluar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const clic = (sel) => evaluar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no existe ${sel.replace(/"/g, "")}"); e.click(); return true; })()`);
const clicTexto = (texto, sel = "button, a") => evaluar(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().includes(${JSON.stringify(texto)})); if (!e) throw new Error("no hay botón: ${texto}"); e.click(); return true; })()`);
const textoDe = (sel) => evaluar(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() || ""`);
const ir = (hash) => evaluar(`location.hash = ${JSON.stringify(hash)}; true`);
async function captura(nombre, selector) {
  let clip;
  if (selector) {
    const r = await evaluar(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`);
    clip = { ...r, scale: 2 };
  } else {
    const met = await cdp("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width: met.result.cssContentSize.width, height: Math.min(met.result.cssContentSize.height, 6000), scale: 1 };
  }
  const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
  writeFileSync(`${DIR}/e2e-${nombre}.png`, Buffer.from(r.result.data, "base64"));
}
// Ids repetidos en el documento rompen etiquetas y selectores (la pantalla de acceso sigue en el DOM).
let pantallasRevisadas = 0;
async function sinIdsRepetidos(donde) {
  const rep = await evaluar(`(() => { const c = {}; for (const e of document.querySelectorAll("[id]")) c[e.id] = (c[e.id] || 0) + 1; return Object.keys(c).filter((k) => c[k] > 1); })()`);
  pantallasRevisadas++;
  if (rep.length) revisar(false, `ids repetidos en ${donde}: ${rep.join(", ")}`);
}
const pantalla = (w, h) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });

try {
  await pantalla(1366, 900);
  await cdp("Page.navigate", { url: `${ORIGEN}/` });
  revisar(await hasta(`!document.getElementById("login").hidden`), "pantalla de acceso");

  // ---- Administrador: entra con correo y contraseña (ficticios) ----
  await clic("#tab-admin");
  await escribir("#email", "admin@prueba.local");
  await escribir("#password", PASS_ADMIN);
  await clic("#btn-entrar");
  revisar(await hasta(`!!document.querySelector(".shell-patron .indicadores")`), "admin entra y ve su tablero");
  revisar((await textoDe(".clave-empresa__valor")) === EMPRESA.clave, `el tablero muestra la clave de la empresa (${EMPRESA.clave})`);
  await sinIdsRepetidos("tablero");
  await captura("tablero");

  // ---- Sitio ----
  await ir("#/sitios/nuevo");
  await hasta(`!!document.querySelector("#lat")`);
  await sinIdsRepetidos("nuevo sitio");
  await escribir("#nombre", "Planta Kino");
  await escribir("#direccion", "Blvd. Kino 100, Hermosillo");
  await escribir("#lat", "29.0892");
  await escribir("#lng", "-110.9613");
  await clicTexto("Agregar sitio", "button");
  revisar(await hasta(`location.hash === "#/sitios" && document.body.textContent.includes("Planta Kino")`), "alta de sitio desde el panel");
  revisar(m.leer(`empresas/${EMPRESA.empresaId}`).sitiosActivos === 1, "el Worker contó 1 sitio activo");

  // ---- Alta de trabajador con consentimiento y foto ----
  await ir("#/trabajadores/nuevo");
  await hasta(`!!document.querySelector("#numero")`);
  await sinIdsRepetidos("alta de trabajador");
  await escribir("#numero", "g-001");
  await escribir("#nombre", "Juan");
  await escribir("#apellidos", "Pérez López");
  await escribir("#fechaNacimiento", "1990-05-10");
  await evaluar(`document.querySelector("input[name=sitio]").checked = true; document.querySelector("input[name=modo][value=telefono]").checked = true; document.querySelector("#consiente").checked = true; true`);
  await clicTexto("Dar de alta", "button");
  revisar(await hasta(`!!document.querySelector(".pin-unico__valor")`), "alta de trabajador: se muestra el PIN una vez");
  const pin = await textoDe(".pin-unico__valor");
  revisar(/^\d{6}$/.test(pin), "PIN de 6 dígitos");
  await captura("alta-pin");
  archivoParaSubir = resolve("icons/icon-512.png"); // "foto" de prueba (se convierte a JPEG en el navegador)
  await clicTexto("Tomar foto", "button");
  revisar(await hasta(`document.body.textContent.includes("Foto guardada")`), "foto tomada, comprimida a JPEG y subida");
  const trabajadorId = m.rutas(`empresas/${EMPRESA.empresaId}/trabajadores/`)[0].split("/").pop();
  const foto = m.leer(`empresas/${EMPRESA.empresaId}/trabajadores/${trabajadorId}`).foto;
  revisar(foto && foto.bytes < 400 * 1024 && [...m.objetos.keys()].some((k) => k.includes(`/fotos/${trabajadorId}/`)), `la foto quedó en R2 privado (${foto?.bytes} bytes)`);

  // ---- Credencial ----
  await clicTexto("Emitir credencial", "button");
  revisar(await hasta(`!!document.querySelector(".credencial svg path")`), "credencial con QR");
  const qrModulos = await evaluar(`document.querySelector(".credencial svg path").getAttribute("d").split("M").length - 1`);
  revisar(qrModulos > 100, `QR dibujado (${qrModulos} módulos)`);
  revisar(await evaluar(`!!document.querySelector(".credencial img.credencial__foto")`), "la credencial lleva la foto");
  await captura("credencial", ".credencial");
  await captura("credencial-vista");
  const guardado = await evaluar(`JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
  revisar(!guardado.includes(pin) && !/HL1[A-Z2-7]{26}/.test(guardado), "ni el PIN ni el código del gafete quedan en el almacenamiento del navegador");

  // ---- Ficha: revocar gafete, restablecer PIN ----
  await clicTexto("Listo");
  revisar(await hasta(`location.hash === "#/trabajador/${trabajadorId}" && document.body.textContent.includes("Gafete activo")`), "ficha con gafete activo");
  await sinIdsRepetidos("ficha");
  await captura("ficha");
  await clicTexto("Revocar gafete", "button");
  revisar(await hasta(`document.body.textContent.includes("Gafete revocado")`), "revocar gafete desde la ficha (con confirmación)");
  await clicTexto("Restablecer PIN", "button");
  revisar(await hasta(`document.querySelectorAll(".pin-unico__valor").length === 1`), "PIN nuevo mostrado una vez");
  const pinNuevo = await textoDe(".pin-unico__valor");
  revisar(pinNuevo !== pin, "el PIN cambió");

  // ---- Configuración: colores, PIN con gafete y logo ----
  await ir("#/configuracion");
  await hasta(`!!document.querySelector("#colorPrimario")`);
  await evaluar(`document.querySelector("#colorPrimario").value = "#1d4ed8"; true`);
  await clicTexto("Guardar colores", "button");
  revisar(await hasta(`document.body.textContent.includes("Colores guardados")`), "colores de la credencial guardados");
  await clic("#pinConGafete");
  revisar(await hasta(`document.body.textContent.includes("Configuración guardada")`), "PIN con gafete activado");
  archivoParaSubir = resolve("icons/icon-192.png");
  await clicTexto("Subir logo", "button");
  revisar(await hasta(`!!document.querySelector("img.marca__logo")`), "logo subido y mostrado");
  const emp = m.leer(`empresas/${EMPRESA.empresaId}`);
  revisar(emp.marca.colorPrimario === "#1D4ED8" && emp.config.pinConGafete === true && !!emp.logo?.id, "el Worker guardó marca, configuración y logo");
  await sinIdsRepetidos("configuración");
  await captura("configuracion");

  // ---- Lista de trabajadores en celular ----
  await pantalla(375, 812);
  await ir("#/trabajadores");
  revisar(await hasta(`document.body.textContent.includes("Pérez López")`), "lista de trabajadores");
  revisar(await evaluar(`document.documentElement.scrollWidth <= innerWidth + 1`), "panel a 375 px sin scroll horizontal");
  await sinIdsRepetidos("lista de trabajadores");
  await captura("trabajadores-movil");

  // ---- Trabajador: entra con clave + número + PIN ----
  await clicTexto("Salir", "button");
  revisar(await hasta(`!document.getElementById("login").hidden`), "cerrar sesión");
  await clic("#tab-trabajador");
  await escribir("#acc-clave", EMPRESA.clave.toLowerCase());
  await escribir("#acc-numero", "G-001");
  await escribir("#acc-pin", pin); // PIN anterior: debe fallar
  await clic("#btn-entrar-empleado");
  revisar(await hasta(`!document.getElementById("login-error").hidden`), "el PIN anterior ya no sirve");
  await escribir("#acc-pin", pinNuevo);
  await clic("#btn-entrar-empleado");
  revisar(await hasta(`!!document.querySelector(".shell-trabajador") && document.body.textContent.includes("G-001")`), "el trabajador entra con clave + número + PIN y ve su ficha");
  revisar(await evaluar(`document.body.textContent.includes("Revocado")`), "ve que su gafete está revocado (checa con número y PIN)");
  revisar(await evaluar(`!!document.querySelector("img.avatar--foto")`), "ve su propia foto");
  await sinIdsRepetidos("inicio del trabajador");
  await esperar(800); // los íconos del sprite externo terminan de pintarse
  await captura("trabajador-movil");
  revisar(pantallasRevisadas === 7, `sin ids repetidos en ${pantallasRevisadas} pantallas`);

  // ---- Seguridad del navegador ----
  const csp = JSON.parse((await evaluar(`sessionStorage.__csp || "[]"`)) || "[]");
  revisar(csp.length === 0, `sin violaciones de CSP ${csp.length ? JSON.stringify(csp) : ""}`);
  const errores = eventos.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !/status of 401/.test(e.params.entry.text)))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text);
  revisar(errores.length === 0, `sin errores en consola ${errores.length ? JSON.stringify(errores.slice(0, 3)) : ""}`);
  const externos = [...new Set(eventos.filter((e) => e.method === "Fetch.requestPaused").map((e) => new URL(e.params.request.url).host))];
  revisar(externos.every((h) => ["127.0.0.1:8787", "firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com"].includes(h)), `solo se contactaron los dominios permitidos (simulados): ${externos.join(", ")}`);
  const todo = JSON.stringify([...m.docs.entries()]);
  revisar(!todo.includes(`"${pin}"`) && !todo.includes(`"${pinNuevo}"`), "ningún PIN quedó en Firestore");
} catch (e) {
  fallas++;
  console.log("FALLA", e.message);
  await captura("error").catch(() => {});
  console.log("Peticiones interceptadas:", interceptados.slice(-15));
  console.log("Consola:", eventos.filter((x) => x.method === "Runtime.exceptionThrown" || x.method === "Log.entryAdded" || x.method === "Runtime.consoleAPICalled")
    .map((x) => x.params.exceptionDetails?.exception?.description || x.params.entry?.text || x.params.args?.map((a) => a.value || a.description).join(" ")).slice(-10));
} finally {
  ws.close();
  spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  web.kill();
  await esperar(800);
  try { rmSync(PERFIL, { recursive: true, force: true }); } catch { /* se limpia después */ }
}
console.log(fallas ? `\n${fallas} FALLA(S)` : "\nPunta a punta local: todo OK");
process.exit(fallas ? 1 : 0);
