// Escaneo de secretos. Sale con código 1 si encuentra algo.
//   node tools/scan-secrets.mjs            → árbol de trabajo + TODO el historial de git
//   node tools/scan-secrets.mjs --staged   → solo lo que está por entrar al commit (lo usa el hook pre-commit)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PATRONES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "llave privada PEM"],
  [/"private_key"\s*:\s*"-----BEGIN/, "private_key de cuenta de servicio"],
  [/"type"\s*:\s*"service_account"/, "JSON de cuenta de servicio"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "token de GitHub"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "token de GitHub"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, "token OAuth de Google"],
  [/\b1\/\/0[0-9A-Za-z_-]{40,}/, "refresh token de Google"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT"],
  [/\b(CLOUDFLARE|CF)_API_(TOKEN|KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/, "token de Cloudflare"],
  [/\b(SETUP_TOKEN|SERVICE_ACCOUNT_JSON|PIN_PEPPER)\s*[=:]\s*["']?[A-Za-z0-9+/=_{-]{16,}/, "secret del Worker en claro"],
  [/\bsk-(ant-|live_|proj-)?[A-Za-z0-9_-]{20,}/, "API key (sk-…)"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{20,}/, "llave de Stripe en vivo"],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/, "token de Slack"],
  [/\bAKIA[0-9A-Z]{16}\b/, "llave de AWS"],
  [/(password|contrase[nñ]a)\s*[=:]\s*["'][^"'\s]{8,}["']/i, "contraseña en claro"],
];

// Llaves de Google (AIza…): se revisan en TODOS los archivos de texto, sin excepciones de carpeta.
// Única excepción: la apiKey web de Firebase, pública por diseño y restringida por dominio
// (comprobar con `npm run verify:apikey`). Vale SOLO para esa llave exacta (fijada por su SHA-256)
// y SOLO en js/config.js. Cualquier otra AIza…, o esa misma en otro archivo, es un hallazgo.
const RE_GOOGLE = /AIza[0-9A-Za-z_-]{35}/g;
const PERMITIDA = { archivo: "js/config.js", sha256: "44064ad8035b53372be105eabbc9693cf4418435d03313dc71ddeec453bfb25c" };
const MENSAJE_PERMITIDO = "PERMITIDO: apiKey web pública en js/config.js (restringida por dominio)";

// Nombres de archivo que nunca deben entrar al repo.
const ARCHIVOS_PROHIBIDOS = /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|.*\.(pem|key|p12|pfx)|.*service-?account.*\.json|.*firebase-adminsdk.*\.json)$/i;

// Binarios: no se leen. Para el resto de patrones se omiten el propio escáner (contiene los patrones),
// el bundle de Firebase y package-lock.json; la regla de llaves de Google SÍ los revisa.
// Las pruebas también se revisan: sus llaves y tokens se generan en memoria, nunca en el código.
const BINARIO = /\.(png|woff2|ico|jpg|jpeg|webp|zip)$/i;
const SOLO_GOOGLE = /(^|\/)package-lock\.json$|^js\/vendor\/|^tools\/scan-secrets\.mjs$/;
const OMITIR_DIRS = new Set(["node_modules", ".git", ".wrangler", ".tools", ".firebase"]);

let hallazgos = 0;
const permitidos = new Set();
const reportar = (donde, desc) => { console.log(`HALLAZGO  ${desc}  →  ${donde}`); hallazgos++; };
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// archivo: ruta relativa con "/" (decide la excepción); donde: texto para el reporte.
function revisarTexto(archivo, donde, texto) {
  for (const m of texto.matchAll(RE_GOOGLE)) {
    if (archivo === PERMITIDA.archivo && sha256(m[0]) === PERMITIDA.sha256) permitidos.add(donde);
    else reportar(donde, `API key de Google (${m[0].slice(0, 4)}…) fuera de la excepción permitida`);
  }
  if (SOLO_GOOGLE.test(archivo)) return;
  for (const [re, desc] of PATRONES) {
    if (new RegExp(re.source, re.flags.includes("i") ? "gi" : "g").test(texto)) reportar(donde, desc);
  }
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

if (process.argv.includes("--staged")) {
  const archivos = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
  for (const f of archivos) {
    if (ARCHIVOS_PROHIBIDOS.test(f)) reportar(f, "archivo de secretos");
    if (BINARIO.test(f)) continue;
    revisarTexto(f, f, git("show", `:${f}`));
  }
  console.log(`${archivos.length} archivo(s) preparados revisados`);
} else {
  const recorrer = (dir) => {
    for (const e of readdirSync(dir)) {
      if (OMITIR_DIRS.has(e)) continue;
      const p = join(dir, e), rel = p.replaceAll("\\", "/");
      if (statSync(p).isDirectory()) { recorrer(p); continue; }
      if (ARCHIVOS_PROHIBIDOS.test(rel)) {
        // Puede existir localmente (p. ej. .dev.vars) si git lo ignora; nunca si está versionado.
        try { git("check-ignore", "-q", rel); } catch { reportar(rel, "archivo de secretos NO ignorado por git"); }
        continue;
      }
      if (!BINARIO.test(rel)) revisarTexto(rel, rel, readFileSync(p, "utf8"));
    }
  };
  recorrer(".");
  try {
    const commits = git("rev-list", "--all").split("\n").filter(Boolean);
    for (const c of commits) {
      const corto = c.slice(0, 8);
      for (const f of git("show", "--format=", "--name-only", c).split("\n").filter(Boolean)) {
        if (ARCHIVOS_PROHIBIDOS.test(f)) reportar(`commit ${corto}: ${f}`, "archivo de secretos en el historial");
      }
      // Diff completo del commit, separado por archivo para aplicar la excepción solo donde corresponde.
      const diff = git("show", "--format=", "--unified=0", "--no-renames", c);
      for (const trozo of diff.split(/^diff --git /m).filter(Boolean)) {
        const archivo = (/^a\/(.+?) b\//.exec(trozo) || [])[1];
        if (!archivo || BINARIO.test(archivo)) continue;
        const agregado = trozo.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
        revisarTexto(archivo, `commit ${corto}: ${archivo}`, agregado);
      }
    }
    console.log(`historial de git revisado: ${commits.length} commit(s)`);
  } catch (e) {
    if (/not a git repository|does not have any commits/i.test(String(e.stderr || e.message))) console.log("sin historial de git todavía");
    else throw e;
  }
}
for (const donde of permitidos) console.log(`${MENSAJE_PERMITIDO}  →  ${donde}`);
console.log(hallazgos ? `${hallazgos} hallazgo(s): NO hagas commit/push hasta resolverlos.` : "sin secretos detectados");
process.exit(hallazgos ? 1 : 0);
