// Credencial imprimible tamaño CR80 (54 × 85.6 mm, vertical) con la marca de cada empresa.
// El QR contiene SOLO el código opaco del gafete; se dibuja aquí mismo con qrcode-generator (copiado en el repo).
import { qrcode } from "./vendor/qr.js";
import { el } from "./ui.js";

const SVG = "http://www.w3.org/2000/svg";

// QR como SVG construido con nodos (sin innerHTML). Modo alfanumérico: el código es solo A-Z y 2-7.
export function qrSvg(texto, { margen = 4 } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(texto, "Alphanumeric");
  qr.make();
  const n = qr.getModuleCount();
  const total = n + margen * 2;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + margen} ${y + margen}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Código QR del gafete");
  const fondo = document.createElementNS(SVG, "rect");
  fondo.setAttribute("width", String(total));
  fondo.setAttribute("height", String(total));
  fondo.setAttribute("fill", "#FFFFFF");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "#000000");
  svg.append(fondo, p);
  return svg;
}

// Texto blanco u oscuro según qué contraste mejor con el color de la empresa.
function textoSobre(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? "#FFFFFF" : "#183153";
}

// datos: { empresa: {nombre, marca}, trabajador: {nombre, apellidos, numero}, codigo, fotoUrl, logoUrl }
export function credencial({ empresa, trabajador, codigo, fotoUrl, logoUrl }) {
  const primario = empresa.marca?.colorPrimario || "#0F9D94";
  const secundario = empresa.marca?.colorSecundario || "#183153";
  const tarjeta = el("div", { class: "credencial", role: "img", "aria-label": `Credencial de ${trabajador.nombre} ${trabajador.apellidos}` });
  tarjeta.style.setProperty("--cred-primario", primario);
  tarjeta.style.setProperty("--cred-secundario", secundario);
  tarjeta.style.setProperty("--cred-texto-primario", textoSobre(primario));
  tarjeta.style.setProperty("--cred-texto-secundario", textoSobre(secundario));

  const cabecera = el("div", { class: "credencial__cabecera" },
    logoUrl ? el("img", { class: "credencial__logo", src: logoUrl, alt: empresa.nombre }) : el("span", { class: "credencial__empresa", texto: empresa.nombre }));
  const foto = fotoUrl
    ? el("img", { class: "credencial__foto", src: fotoUrl, alt: "" })
    : el("div", { class: "credencial__foto credencial__foto--vacia", texto: "Sin foto" });
  const qr = el("div", { class: "credencial__qr" }, qrSvg(codigo));
  tarjeta.append(
    cabecera,
    el("div", { class: "credencial__cuerpo" },
      foto,
      el("div", { class: "credencial__nombre", texto: trabajador.nombre }),
      el("div", { class: "credencial__apellidos", texto: trabajador.apellidos }),
      el("div", { class: "credencial__numero", texto: `No. ${trabajador.numero}` }),
      qr),
    el("div", { class: "credencial__pie", texto: logoUrl ? empresa.nombre : "Credencial de trabajador" }),
  );
  return tarjeta;
}
