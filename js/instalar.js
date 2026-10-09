// Aviso propio de "Instalar app": Android (beforeinstallprompt) y iPhone/iPad (Compartir → Agregar a inicio).
import { el, icono } from "./ui.js";

const CLAVE = "hl-instalar-cerrado";
const DIAS = 7;

const instalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function cerradoReciente() {
  try {
    const t = Number(localStorage.getItem(CLAVE) || 0);
    return Date.now() - t < DIAS * 86400000;
  } catch {
    return false;
  }
}
function recordarCierre() {
  try { localStorage.setItem(CLAVE, String(Date.now())); } catch { /* sin almacenamiento: no pasa nada */ }
}

function mostrar(contenido, acciones) {
  document.querySelector(".instalar")?.remove();
  const cerrar = el("button", { class: "boton boton--fantasma", type: "button", "aria-label": "Cerrar aviso" }, icono("cerrar"));
  const caja = el("div", { class: "instalar", role: "dialog", "aria-label": "Instalar Horario Laboral" },
    el("span", { class: "cuadro cuadro--turquesa" }, icono("celular")),
    el("div", { class: "instalar__texto" }, ...contenido),
    ...acciones, cerrar);
  cerrar.addEventListener("click", () => { recordarCierre(); caja.remove(); });
  document.body.append(caja);
  return caja;
}

export function iniciarAvisoInstalar() {
  if (instalada() || cerradoReciente()) return;

  if (esIOS()) {
    mostrar([
      el("strong", { texto: "Instala Horario Laboral" }),
      "Toca ", el("span", { class: "sr-only", texto: "el botón" }),
      icono("compartir-ios", "instalar__compartir"), " ",
      el("b", { texto: "Compartir" }), " y luego ", el("b", { texto: "Agregar a pantalla de inicio" }), ".",
    ], []);
    return;
  }

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    const boton = el("button", { class: "boton boton--primario", type: "button", texto: "Instalar" });
    const caja = mostrar([el("strong", { texto: "Instala Horario Laboral" }), "Abre más rápido y checa aunque falle la señal."], [boton]);
    boton.addEventListener("click", async () => {
      ev.prompt();
      await ev.userChoice.catch(() => null);
      caja.remove();
    });
  });
}
