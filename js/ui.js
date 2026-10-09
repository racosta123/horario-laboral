// Utilidades de interfaz (sin innerHTML con datos: todo el texto entra con textContent).
const SVG = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "texto") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) n.append(h instanceof Node ? h : document.createTextNode(String(h)));
  return n;
}

export function icono(nombre, clase = "") {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", `ic ${clase}`.trim());
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVG, "use");
  u.setAttribute("href", `icons/iconos.svg#${nombre}`);
  s.append(u);
  return s;
}

export function iniciales(nombre = "") {
  const p = nombre.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?";
}

export function saludo(fecha = new Date()) {
  const h = fecha.getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

export function fechaLarga(fecha = new Date()) {
  const s = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long" }).format(fecha);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function cargando(boton, si) {
  boton.classList.toggle("cargando", si);
  boton.disabled = si;
  boton.setAttribute("aria-busy", si ? "true" : "false");
}
