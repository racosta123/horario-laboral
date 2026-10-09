// Íconos PROVISIONALES de la PWA: "HL" blanco sobre turquesa (el logo real de Diagonal Catorce llega después).
// Genera PNG sin dependencias (zlib de Node) con antialiasing por supermuestreo.
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const TURQUESA = [0x0f, 0x9d, 0x94]; // turquesa de marca #0F9D94
const BLANCO = [255, 255, 255];

// Formas en coordenadas relativas (0..1). Rectángulos de las letras H y L.
function letras(escala) {
  const alto = 0.36 * escala, t = 0.088 * escala, anchoH = 0.25 * escala, anchoL = 0.2 * escala, sep = 0.085 * escala;
  const total = anchoH + sep + anchoL;
  const x0 = 0.5 - total / 2, y0 = 0.5 - alto / 2, x1 = x0 + anchoH + sep;
  return [
    [x0, y0, t, alto], [x0 + anchoH - t, y0, t, alto], [x0, 0.5 - t / 2, anchoH, t], // H
    [x1, y0, t, alto], [x1, y0 + alto - t, anchoL, t], // L
  ];
}

function dentroRedondeado(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function png(tam, { maskable }) {
  const rects = letras(maskable ? 0.82 : 1);
  const radio = maskable ? 0 : 0.22;
  const SS = 4;
  const filas = [];
  for (let py = 0; py < tam; py++) {
    const fila = Buffer.alloc(1 + tam * 4);
    for (let px = 0; px < tam; px++) {
      let fondo = 0, letra = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / tam, y = (py + (sy + 0.5) / SS) / tam;
        if (radio === 0 || dentroRedondeado(x, y, radio)) {
          fondo++;
          if (rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh)) letra++;
        }
      }
      const n = SS * SS, a = fondo / n, l = fondo ? letra / fondo : 0;
      const c = TURQUESA.map((v, i) => Math.round(v * (1 - l) + BLANCO[i] * l));
      fila.set([...c, Math.round(a * 255)], 1 + px * 4);
    }
    filas.push(fila);
  }
  const chunk = (tipo, datos) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo), datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(filas), { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("icons", { recursive: true });
for (const [nombre, tam, maskable] of [
  ["icon-192.png", 192, false], ["icon-512.png", 512, false],
  ["maskable-192.png", 192, true], ["maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true], ["favicon-32.png", 32, false],
]) {
  writeFileSync(`icons/${nombre}`, png(tam, { maskable }));
  console.log(`icons/${nombre}`);
}
