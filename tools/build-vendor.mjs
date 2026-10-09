// Copia dentro del repo todo lo de terceros que la app usa en tiempo de ejecución (cero CDNs).
//   - SDK de Firebase Auth (Apache-2.0, Google) → js/vendor/firebase.js
//   - Tipografía Figtree (OFL-1.1) → fonts/
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("js/vendor", { recursive: true });
await build({
  entryPoints: ["tools/firebase-entry.js"],
  outfile: "js/vendor/firebase.js",
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2020", legalComments: "none",
});
const v = JSON.parse(readFileSync("node_modules/firebase/package.json", "utf8")).version;
// El paquete npm no incluye archivo LICENSE: se deja el aviso de licencia (Apache-2.0).
writeFileSync("js/vendor/LICENSE-firebase.txt", `Firebase JavaScript SDK ${v} (firebase/app + firebase/auth)
Copyright Google LLC
Licencia: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
Fuente: https://github.com/firebase/firebase-js-sdk
`);
console.log(`firebase ${v} → js/vendor/firebase.js`);

mkdirSync("fonts", { recursive: true });
for (const w of [400, 500, 600, 700, 800]) {
  copyFileSync(`node_modules/@fontsource/figtree/files/figtree-latin-${w}-normal.woff2`, `fonts/figtree-${w}.woff2`);
}
copyFileSync("node_modules/@fontsource/figtree/LICENSE", "fonts/LICENSE-Figtree-OFL.txt");
console.log("Figtree 400-800 → fonts/");
