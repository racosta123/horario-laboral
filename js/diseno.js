// Interacciones de la página de muestra del sistema de diseño (datos de ejemplo).
import { el, icono } from "./ui.js";

// Gráfica apilada: altura proporcional al día con más horas.
const cols = [...document.querySelectorAll("#d-grafica .grafica__col")];
const max = Math.max(...cols.map((c) => Number(c.dataset.ord) + Number(c.dataset.ext)));
for (const c of cols) {
  const ord = Number(c.dataset.ord), ext = Number(c.dataset.ext);
  c.querySelector(".grafica__barra").style.height = `${((ord + ext) / max) * 82}%`;
  c.querySelector(".grafica__ord").style.flexBasis = `${(ord / (ord + ext)) * 100}%`;
  c.querySelector(".grafica__ext").style.flexBasis = `${(ext / (ord + ext)) * 100}%`;
}

// Tope semanal: 46 h ordinarias + 9 h extra = 55 h.
for (const p of document.querySelectorAll("#d-topes .progreso")) {
  p.querySelector(".progreso__valor").style.width = `${Math.min(100, (Number(p.dataset.h) / 55) * 100)}%`;
}

// Filtros de la tabla.
const filtros = document.getElementById("d-filtros");
filtros.addEventListener("click", (ev) => {
  const b = ev.target.closest(".filtro");
  if (!b) return;
  for (const x of filtros.querySelectorAll(".filtro")) x.setAttribute("aria-pressed", String(x === b));
  for (const tr of document.querySelectorAll("#d-tabla tbody tr")) tr.hidden = b.dataset.f !== "todos" && tr.dataset.e !== b.dataset.f;
});

// Botón con estado "cargando".
const bc = document.getElementById("d-btn-cargar");
bc.addEventListener("click", () => {
  bc.classList.add("cargando"); bc.disabled = true;
  setTimeout(() => { bc.classList.remove("cargando"); bc.disabled = false; }, 1800);
});

// Checar → confirmación.
const checar = document.getElementById("d-checar"), ok = document.getElementById("d-confirmado");
checar.addEventListener("click", () => { checar.hidden = true; ok.hidden = false; });
ok.addEventListener("click", () => { ok.hidden = true; checar.hidden = false; });

// Catálogo de íconos del sprite.
const nombres = ["reloj", "tablero", "registros", "trabajadores", "horarios", "reporte", "convenio", "config", "presentes", "ausencias", "retardos",
  "sincronizar", "alerta", "qr", "camara", "ubicacion", "inicio", "historial", "mi-horario", "perfil", "check", "agregar-persona", "descargar",
  "escudo", "salir", "nube", "comida", "entrada", "info", "cerrar", "compartir-ios", "celular", "edificio"];
document.getElementById("d-catalogo").append(...nombres.map((n) => el("div", { class: "d-icono" }, icono(n), el("code", { texto: n }))));
