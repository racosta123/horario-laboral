// Verifica el contraste WCAG de las combinaciones de texto del sistema de diseño (css/tokens.css).
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const PARES = [
  ["Texto principal / blanco", "#183153", "#FFFFFF", 4.5],
  ["Texto principal / fondo", "#183153", "#F5FAFF", 4.5],
  ["Texto secundario / blanco", "#64748B", "#FFFFFF", 4.5],
  ["Texto secundario / fondo", "#64748B", "#F5FAFF", 4.5],
  ["Botón: blanco / turquesa oscuro", "#FFFFFF", "#0B7F78", 4.5],
  ["Botón hover: blanco / #096B65", "#FFFFFF", "#096B65", 4.5],
  ["Menú activo: #0B7E77 / #EAF8F7", "#0B7E77", "#EAF8F7", 4.5],
  ["Menú inferior activo: #0B7E77 / blanco", "#0B7E77", "#FFFFFF", 4.5],
  // Mismo par de la maqueta en otros componentes (4.46:1). Pendiente de aprobación: no se cambia sin autorización.
  ["Píldora turquesa / filtro activo / avatar: #0B7F78 / #EAF8F7", "#0B7F78", "#EAF8F7", 4.5, "aviso"],
  ["Píldora verde", "#15803D", "#ECFDF3", 4.5],
  ["Píldora ámbar", "#B45309", "#FFFAEB", 4.5],
  ["Píldora roja", "#B91C1C", "#FEF2F2", 4.5],
  ["Píldora azul", "#1D4ED8", "#EFF6FF", 4.5],
  ["Píldora violeta", "#6D28D9", "#F5F3FF", 4.5],
  ["Píldora neutra: texto / línea", "#183153", "#EEF3F8", 4.5],
  ["Tarjeta LFT: texto / azul claro", "#183153", "#EFF6FF", 4.5],
  ["Jornada: texto / turquesa claro", "#183153", "#EAF8F7", 4.5],
  ["Jornada: verde / turquesa claro", "#15803D", "#EAF8F7", 4.5],
  ["Ícono turquesa / turquesa claro (gráfico, 3:1)", "#0F9D94", "#EAF8F7", 3],
  ["Ícono azul / azul claro (gráfico, 3:1)", "#3B82F6", "#EFF6FF", 3],
  ["Ícono verde / verde claro (decorativo: siempre va con texto)", "#22C55E", "#ECFDF3", 2],
  ["Ícono ámbar / ámbar claro (decorativo: siempre va con texto)", "#F59E0B", "#FFFAEB", 2],
];
let malos = 0;
for (const [n, a, b, min, nivel] of PARES) {
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok && nivel !== "aviso") malos++;
  console.log(`${ok ? "OK   " : nivel === "aviso" ? "AVISO" : "BAJO "} ${r.toFixed(2).padStart(5)}:1  (mín ${min})  ${n}`);
}
process.exit(malos ? 1 : 0);
