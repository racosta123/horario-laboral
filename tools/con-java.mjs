// Ejecuta un comando con el JDK portátil de .tools/ (si existe) en PATH. Uso: node tools/con-java.mjs <comando...>
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const env = { ...process.env, NO_UPDATE_NOTIFIER: "1" };
const tools = resolve(".tools");
const jdk = existsSync(tools) && readdirSync(tools).find((d) => d.startsWith("jdk"));
if (jdk) {
  env.JAVA_HOME = join(tools, jdk);
  env.PATH = join(env.JAVA_HOME, "bin") + delimiter + (env.PATH || env.Path || "");
  delete env.Path;
}
const linea = process.argv.slice(2).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
const r = spawnSync(linea, { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 1);
