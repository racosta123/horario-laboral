// Servidor estático SOLO para desarrollo (http://localhost:5173). Sin dependencias.
// En el HTML agrega a connect-src el Worker local de `wrangler dev` (127.0.0.1:8787); en producción no existe.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const RAIZ = resolve(".");
const PUERTO = Number(process.env.PORT || 5173);
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};
const PROHIBIDO = /(^|[\/])(\.|node_modules|worker|tools|tests|firebase)([\/]|$)/;

createServer(async (req, res) => {
  try {
    let ruta = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (ruta.endsWith("/")) ruta += "index.html";
    const archivo = normalize(join(RAIZ, ruta));
    const rel = archivo.slice(RAIZ.length);
    if (!archivo.startsWith(RAIZ) || PROHIBIDO.test(rel)) throw Object.assign(new Error(), { code: "ENOENT" });
    if (!(await stat(archivo)).isFile()) throw Object.assign(new Error(), { code: "ENOENT" });
    let cuerpo = await readFile(archivo);
    const ext = extname(archivo);
    if (ext === ".html") cuerpo = cuerpo.toString("utf8").replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:8787");
    res.writeHead(200, { "content-type": TIPOS[ext] || "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(cuerpo);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(e.code === "ENOENT" ? "No encontrado" : "Error");
  }
}).listen(PUERTO, "127.0.0.1", () => console.log(`http://localhost:${PUERTO}/  ·  diseño: http://localhost:${PUERTO}/diseno.html`));
