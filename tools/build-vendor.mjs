// Copia dentro del repo todo lo de terceros que la app usa en tiempo de ejecución (cero CDNs).
//   - SDK de Firebase: Auth + Firestore Lite (Apache-2.0, Google) → js/vendor/firebase.js
//   - qrcode-generator (MIT, Kazuhiko Arase) → js/vendor/qr.js
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
writeFileSync("js/vendor/LICENSE-firebase.txt", `Firebase JavaScript SDK ${v} (firebase/app + firebase/auth + firebase/firestore/lite)\nCopyright Google LLC\nLicencia: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0\nFuente: https://github.com/firebase/firebase-js-sdk\n`);
console.log(`firebase ${v} → js/vendor/firebase.js`);

await build({
  entryPoints: ["tools/qr-entry.js"],
  outfile: "js/vendor/qr.js",
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2020", legalComments: "none",
});
// El paquete no trae archivo LICENSE: se conserva el aviso de copyright de su cabecera (MIT).
const qrv = JSON.parse(readFileSync("node_modules/qrcode-generator/package.json", "utf8")).version;
const cabecera = readFileSync("node_modules/qrcode-generator/dist/qrcode.mjs", "utf8").split(/\r?\n/).slice(0, 16).join("\n");
writeFileSync("js/vendor/LICENSE-qrcode-generator.txt", `qrcode-generator ${qrv} (MIT) — https://github.com/kazuhikoarase/qrcode-generator\n\n${cabecera}\n`);
console.log(`qrcode-generator ${qrv} → js/vendor/qr.js`);

mkdirSync("fonts", { recursive: true });
for (const w of [400, 500, 600, 700, 800]) {
  copyFileSync(`node_modules/@fontsource/figtree/files/figtree-latin-${w}-normal.woff2`, `fonts/figtree-${w}.woff2`);
}
copyFileSync("node_modules/@fontsource/figtree/LICENSE", "fonts/LICENSE-Figtree-OFL.txt");
console.log("Figtree 400-800 → fonts/");
