// Horario Laboral — arranque de la PWA: sesión, rol e inicio según el rol.
// Fase 0: solo el esqueleto. Los datos de cada pantalla se conectan en fases siguientes.
import { alCambiarSesion, entrar, mensajeError, restablecer, rolActual, salir } from "./auth.js";
import { api } from "./api.js";
import { iniciarAvisoInstalar } from "./instalar.js";
import { cargando, el, fechaLarga, icono, iniciales, saludo } from "./ui.js";

const $ = (id) => document.getElementById(id);

function mostrarPantalla(id) {
  for (const p of ["cargando", "login", "app"]) $(p).hidden = p !== id;
  document.body.classList.toggle("con-menu-inferior", false);
}

// ---------- Inicio de sesión ----------
function avisoLogin(tipo, texto) {
  $("login-error").hidden = tipo !== "error";
  $("login-info").hidden = tipo !== "info";
  if (tipo) $(tipo === "error" ? "login-error" : "login-info").textContent = texto;
}

$("form-login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("email").value, password = $("password").value;
  if (!email || !password) return avisoLogin("error", "Escribe tu correo y tu contraseña.");
  const b = $("btn-entrar");
  cargando(b, true);
  avisoLogin(null);
  try {
    await entrar(email, password);
    $("password").value = "";
  } catch (e) {
    avisoLogin("error", mensajeError(e));
  } finally {
    cargando(b, false);
  }
});

$("btn-olvide").addEventListener("click", async () => {
  const email = $("email").value.trim();
  if (!email) return avisoLogin("error", "Escribe tu correo arriba y vuelve a tocar «Olvidé mi contraseña».");
  const b = $("btn-olvide");
  cargando(b, true);
  // Mismo mensaje exista o no la cuenta (no se revela qué correos están registrados).
  await restablecer(email).catch(() => {});
  cargando(b, false);
  avisoLogin("info", "Si el correo está registrado, te llegará un enlace para crear una contraseña nueva.");
});

// ---------- Piezas comunes ----------
const OPCIONES_PATRON = [
  ["tablero", "Tablero"], ["registros", "Registros"], ["trabajadores", "Trabajadores"], ["horarios", "Horarios"],
  ["reporte", "Reportes STPS"], ["convenio", "Convenios"], ["config", "Configuración"],
];

function logo() {
  return el("div", { class: "logo" },
    el("span", { class: "logo__marca" }, icono("reloj")),
    el("span", {}, el("span", { class: "logo__nombre", texto: "Horario Laboral" }), el("br"), el("span", { class: "logo__por", texto: "por Diagonal Catorce" })));
}

function botonSalir() {
  return el("button", { class: "boton", type: "button", onclick: () => salir() }, icono("salir", "ic-sm"), "Salir");
}

function menuLateral(opciones) {
  return el("aside", { class: "menu-lateral" },
    logo(),
    el("nav", { "aria-label": "Menú principal" },
      el("ul", {}, opciones.map(([ic, txt], i) => el("li", {},
        el("a", { class: "menu-lateral__item", href: "#", "aria-current": i === 0 ? "page" : null, "aria-disabled": i === 0 ? null : "true" },
          icono(ic), txt))))),
    el("div", { class: "menu-lateral__pie" },
      el("div", { class: "tarjeta-lft" }, el("span", { class: "cuadro cuadro--azul cuadro--sm" }, icono("escudo", "ic-sm")),
        el("strong", { texto: "Cumplimiento LFT" }), el("p", { texto: "Registro electrónico obligatorio desde el 1 de enero de 2027." }))));
}

function encabezado(yo, extra = []) {
  const contexto = [fechaLarga(), yo.empresa?.nombre].filter(Boolean).join(" · ");
  const nombre = (yo.nombre || "").split(/\s+/)[0];
  return el("header", { class: "encabezado" },
    el("div", {}, el("p", { class: "secundario", texto: contexto }), el("h1", { class: "titulo-grande", texto: `${saludo()}${nombre ? `, ${nombre}` : ""}` })),
    el("div", { class: "encabezado__acciones" }, ...extra, botonSalir()));
}

function proximamente(texto) {
  return el("div", { class: "aviso aviso--azul" }, icono("info"), el("div", { class: "aviso__texto", texto }));
}

// ---------- Inicio por rol ----------
function inicioPatron(yo) {
  const contenido = el("main", { class: "contenido" },
    encabezado(yo),
    proximamente(yo.rol === "supervisor"
      ? "Tu tablero de supervisor se conecta en la siguiente fase."
      : "Tu tablero (asistencia de hoy, horas de la semana y reportes STPS) se conecta en la siguiente fase."));
  return el("div", { class: "shell-patron" }, menuLateral(OPCIONES_PATRON), contenido);
}

function inicioSuperadmin(yo) {
  const resultado = el("div", { role: "status" });
  const campo = (id, etiqueta, tipo = "text", extra = {}) => el("div", { class: "campo" },
    el("label", { for: id, texto: etiqueta }), el("input", { id, name: id, type: tipo, required: extra.opcional ? null : true, maxlength: extra.max || 120, autocomplete: "off" }));
  const enviar = el("button", { class: "boton boton--primario", type: "submit" }, icono("edificio", "ic-sm"), "Dar de alta");
  const form = el("form", { class: "formulario formulario--2", novalidate: true },
    campo("emp-nombre", "Nombre de la empresa"),
    campo("emp-rfc", "RFC (opcional)", "text", { opcional: true, max: 13 }),
    campo("adm-nombre", "Nombre del administrador", "text", { max: 80 }),
    campo("adm-email", "Correo del administrador", "email", { max: 254 }),
    el("div", { class: "formulario__fin" }, enviar));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = (id) => form.querySelector(`#${id}`).value.trim();
    cargando(enviar, true);
    resultado.replaceChildren();
    try {
      const r = await api("POST", "/v1/empresas", { nombre: v("emp-nombre"), rfc: v("emp-rfc"), admin: { nombre: v("adm-nombre"), email: v("adm-email") } });
      form.reset();
      resultado.append(el("div", { class: "aviso aviso--verde" }, icono("check"), el("div", { class: "aviso__texto" },
        "Empresa creada.", el("small", { texto: r.correoEnviado ? "El administrador recibirá un correo para crear su contraseña." : "No se pudo enviar el correo; el administrador puede usar «Olvidé mi contraseña»." }))));
    } catch (e) {
      const txt = e.codigo === "correo_existente" ? "Ese correo ya tiene cuenta." : e.detalle || (e.status === 429 ? "Demasiadas altas seguidas; espera un momento." : "No se pudo crear la empresa.");
      resultado.append(el("div", { class: "aviso aviso--rojo" }, icono("alerta"), el("div", { class: "aviso__texto", texto: txt })));
    } finally {
      cargando(enviar, false);
    }
  });
  const contenido = el("main", { class: "contenido" },
    encabezado({ ...yo, empresa: { nombre: "Diagonal Catorce" } }),
    el("section", { class: "tarjeta" },
      el("div", { class: "tarjeta__cabecera" }, el("h2", { class: "tarjeta__titulo", texto: "Nueva empresa" }), el("span", { class: "pildora pildora--violeta", texto: "Superadmin" })),
      form, resultado));
  return el("div", { class: "shell-patron" }, menuLateral([["edificio", "Empresas"]]), contenido);
}

function inicioTrabajador(yo) {
  document.body.classList.add("con-menu-inferior");
  const nombre = (yo.nombre || "").split(/\s+/)[0];
  const opciones = [["inicio", "Inicio"], ["historial", "Historial"], ["mi-horario", "Mi horario"], ["perfil", "Perfil"]];
  return el("div", { class: "shell-trabajador" },
    el("header", { class: "encabezado-trab" },
      el("div", {}, el("p", { class: "secundario", texto: yo.empresa?.nombre || "" }), el("h1", { class: "titulo-grande", texto: `Hola${nombre ? `, ${nombre}` : ""}` })),
      el("span", { class: "avatar avatar--lg", "aria-hidden": "true", texto: iniciales(yo.nombre) })),
    el("main", { class: "contenido-trab" },
      proximamente("Tu jornada y el botón para checar se activan en la siguiente fase."),
      el("div", { class: "fila-fin" }, botonSalir())),
    el("nav", { class: "menu-inferior", "aria-label": "Menú" },
      el("ul", {}, opciones.map(([ic, txt], i) => el("li", {},
        el("a", { class: "menu-inferior__item", href: "#", "aria-current": i === 0 ? "page" : null },
          el("span", { class: "menu-inferior__pastilla" }, icono(ic)), txt))))));
}

function sinAcceso(texto) {
  return el("main", { class: "pantalla-centro" },
    el("section", { class: "tarjeta login" }, logo(),
      el("div", { class: "aviso aviso--ambar" }, icono("alerta"), el("div", { class: "aviso__texto", texto })),
      el("button", { class: "boton boton--primario boton--bloque", type: "button", onclick: () => salir() }, "Volver al inicio")));
}

// ---------- Sesión ----------
alCambiarSesion(async (usuario) => {
  if (!usuario) return mostrarPantalla("login");
  mostrarPantalla("cargando");
  const app = $("app");
  try {
    // Una cuenta sin rol (claims) no tiene acceso a nada; ni siquiera se consulta al Worker.
    const rol = await rolActual(true);
    if (!rol) {
      app.replaceChildren(sinAcceso("Tu cuenta todavía no tiene acceso. Pide a tu empresa que te dé de alta."));
      return mostrarPantalla("app");
    }
    const yo = await api("GET", "/v1/yo");
    const vista = yo.rol === "superadmin" ? inicioSuperadmin(yo) : yo.rol === "trabajador" ? inicioTrabajador(yo) : inicioPatron(yo);
    app.replaceChildren(vista);
    mostrarPantalla("app");
    if (yo.rol === "trabajador") document.body.classList.add("con-menu-inferior");
  } catch (e) {
    const txt = e.status === 403 ? "Tu cuenta no tiene acceso o fue dada de baja. Habla con tu administrador."
      : e.codigo === "sin_conexion" ? "Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
        : "No pudimos cargar tu cuenta. Inténtalo de nuevo en un momento.";
    app.replaceChildren(sinAcceso(txt));
    mostrarPantalla("app");
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
iniciarAvisoInstalar();
