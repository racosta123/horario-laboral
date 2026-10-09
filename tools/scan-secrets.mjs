// Escaneo de secretos. Sale con código 1 si encuentra algo.
//   node tools/scan-secrets.mjs            → árbol de trabajo + TODO el historial de git
//   node tools/scan-secrets.mjs --staged   → solo lo que está por entrar al commit (lo usa el hook pre-commit)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PATRONES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "llave privada PEM"],
  [/"private_key"\s*:\s*"-----BEGIN/, "private_key de cuenta de servicio"],
  [/"type"\s*:\s*"service_account"/, "JSON de cuenta de servicio"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "token de GitHub"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "token de GitHub"],
  [/AIza[0-9A-Za-z_-]{35}/, "API key de Google (solo se permite la apiKey web de js/config.js)"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, "token OAuth de Google"],
  [/\b1\/\/0[0-9A-Za-z_-]{40,}/, "refresh token de Google"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT"],
  [/\b(CLOUDFLARE|CF)_API_(TOKEN|KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/, "token de Cloudflare"],
  [/\b(SETUP_TOKEN|SERVICE_ACCOUNT_JSON)\s*[=:]\s*["']?[A-Za-z0-9+/=_{-]{16,}/, "secret del Worker en claro"],
  [/\bsk-(ant-|live_|proj-)?[A-Za-z0-9_-]{20,}/, "API key (sk-…)"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{20,}/, "llave de Stripe en vivo"],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/, "token de Slack"],
  [/\bAKIA[0-9A-Z]{16}\b/, "llave de AWS"],
  [/(password|contrase[nñ]a)\s*[=:]\s*["'][^"'\s]{8,}["']/i, "contraseña en claro"],
];
// Nombres de archivo que nunca deben entrar al repo.
const ARCHIVOS_PROHIBIDOS = /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|.*\.(pem|key|p12|pfx)|.*service-?account.*\.json|.*firebase-adminsdk.*\.json)$/i;

// Excepciones justificadas: binarios, el propio escáner (contiene los patrones) y el bundle de Firebase.
// Las pruebas SÍ se revisan: sus llaves y tokens se generan en memoria, nunca en el código.
const OMITIR = /\.(png|woff2|ico|jpg|jpeg|webp)$|(^|\/)package-lock\.json$|^js\/vendor\/|^tools\/scan-secrets\.mjs$/;
const OMITIR_DIRS = new Set(["node_modules", ".git", ".wrangler", ".tools", ".firebase"]);

// La apiKey web de Firebase es pública por diseño; se permite SOLO la que está en js/config.js.
let publicas = new Set();
try { publicas = new Set(readFileSync("js/config.js", "utf8").match(/AIza[0-9A-Za-z_-]{35}/g) || []); } catch { /* sin config */ }

let hallazgos = 0;
const reportar = (donde, desc) => { console.log(`HALLAZGO  ${desc}  →  ${donde}`); hallazgos++; };

function revisarTexto(donde, texto) {
  for (const [re, desc] of PATRONES) {
    const g = new RegExp(re.source, re.flags.includes("i") ? "gi" : "g");
    if ([...texto.matchAll(g)].some((m) => !publicas.has(m[0]))) reportar(donde, desc);
  }
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

if (process.argv.includes("--staged")) {
  const archivos = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
  for (const f of archivos) {
    if (ARCHIVOS_PROHIBIDOS.test(f)) reportar(f, "archivo de secretos");
    if (OMITIR.test(f)) continue;
    revisarTexto(f, git("show", `:${f}`));
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
      if (!OMITIR.test(rel)) revisarTexto(rel, readFileSync(p, "utf8"));
    }
  };
  recorrer(".");
  try {
    const commits = git("rev-list", "--all").split("\n").filter(Boolean);
    for (const c of commits) {
      for (const f of git("show", "--format=", "--name-only", c).split("\n").filter(Boolean)) {
        if (ARCHIVOS_PROHIBIDOS.test(f)) reportar(`commit ${c.slice(0, 8)}: ${f}`, "archivo de secretos en el historial");
      }
      const diff = git("show", "--format=", "--unified=0", c, "--", ".", ":(exclude)js/vendor",
        ":(exclude)tools/scan-secrets.mjs", ":(exclude)package-lock.json", ":(exclude)*.png", ":(exclude)*.woff2");
      revisarTexto(`commit ${c.slice(0, 8)}`, diff);
    }
    console.log(`historial de git revisado: ${commits.length} commit(s)`);
  } catch {
    console.log("sin historial de git todavía");
  }
}
console.log(hallazgos ? `${hallazgos} hallazgo(s): NO hagas commit/push hasta resolverlos.` : "sin secretos detectados");
process.exit(hallazgos ? 1 : 0);
