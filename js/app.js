// Horario Laboral — arranque de la PWA: sesión, rol e inicio según el rol.
//   superadmin → alta de empresas · admin_empresa → panel (admin.js) · supervisor → por ahora aviso
//   trabajador → su ficha (el checado llega en la Fase 2)
import { alCambiarSesion, entrar, entrarConToken, mensajeError, restablecer, rolActual, salir } from "./auth.js";
import { api, apiPublica, imagenPrivada, mensajeErrorApi } from "./api.js";
import { desmontarAdmin, montarAdmin } from "./admin.js";
import * as datos from "./datos.js";
import { iniciarAvisoInstalar } from "./instalar.js";
import { cargando, el, fechaLarga, icono, iniciales, saludo } from "./ui.js";

const $ = (id) => document.getElementById(id);

function mostrarPantalla(id) {
  for (const p of ["cargando", "login", "app"]) $(p).hidden = p !== id;
  document.body.classList.remove("con-menu-inferior", "vista-credencial");
}

// ---------- Inicio de sesión ----------
function avisoLogin(tipo, texto) {
  $("login-error").hidden = tipo !== "error";
  $("login-info").hidden = tipo !== "info";
  if (tipo) $(tipo === "error" ? "login-error" : "login-info").textContent = texto;
}

// Pestañas: "Soy administrador" (correo) / "Soy trabajador" (clave + número + PIN).
function elegirModoLogin(modo) {
  const trabajador = modo === "trabajador";
  $("tab-admin").setAttribute("aria-selected", String(!trabajador));
  $("tab-trabajador").setAttribute("aria-selected", String(trabajador));
  $("form-login").hidden = trabajador;
  $("form-empleado").hidden = !trabajador;
  avisoLogin(null);
  try { localStorage.setItem("hl-login-modo", modo); } catch { /* sin almacenamiento: no pasa nada */ }
}
$("tab-admin").addEventListener("click", () => elegirModoLogin("admin"));
$("tab-trabajador").addEventListener("click", () => elegirModoLogin("trabajador"));
try { if (localStorage.getItem("hl-login-modo") === "trabajador") elegirModoLogin("trabajador"); } catch { /* idem */ }

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

$("form-empleado").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const clave = $("acc-clave").value.trim().toUpperCase(), numero = $("acc-numero").value.trim().toUpperCase(), pin = $("acc-pin").value.trim();
  if (!clave || !numero || !/^\d{6}$/.test(pin)) return avisoLogin("error", "Escribe la clave de tu empresa, tu número de empleado y tu PIN de 6 dígitos.");
  const b = $("btn-entrar-empleado");
  cargando(b, true);
  avisoLogin(null);
  try {
    const { token } = await apiPublica("POST", "/v1/empleado/entrar", { clave, numero, pin });
    await entrarConToken(token);
    $("acc-pin").value = "";
    try { localStorage.setItem("hl-clave", clave); } catch { /* idem */ }
  } catch (e) {
    avisoLogin("error", mensajeErrorApi(e, "No se pudo entrar."));
  } finally {
    cargando(b, false);
  }
});
try { $("acc-clave").value = localStorage.getItem("hl-clave") || ""; } catch { /* idem */ }

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
function logo() {
  return el("div", { class: "logo" },
    el("span", { class: "logo__marca" }, icono("reloj")),
    el("span", {}, el("span", { class: "logo__nombre", texto: "Horario Laboral" }), el("br"), el("span", { class: "logo__por", texto: "por Diagonal Catorce" })));
}
const botonSalir = () => el("button", { class: "boton", type: "button", onclick: () => salir() }, icono("salir", "ic-sm"), "Salir");
const aviso = (tipo, texto) => el("div", { class: `aviso aviso--${tipo}` }, icono(tipo === "rojo" ? "alerta" : "info"), el("div", { class: "aviso__texto", texto }));

function encabezado(yo, contexto) {
  const nombre = (yo.nombre || "").split(/\s+/)[0];
  return el("header", { class: "encabezado" },
    el("div", {}, el("p", { class: "secundario", texto: [fechaLarga(), contexto].filter(Boolean).join(" · ") }),
      el("h1", { class: "titulo-grande", texto: `${saludo()}${nombre ? `, ${nombre}` : ""}` })),
    el("div", { class: "encabezado__acciones" }, botonSalir()));
}

function menuSimple(opciones) {
  return el("aside", { class: "menu-lateral" }, logo(),
    el("nav", { "aria-label": "Menú principal" },
      el("ul", {}, opciones.map(([ic, txt], i) => el("li", {},
        el("span", { class: "menu-lateral__item", "aria-current": i === 0 ? "page" : null }, icono(ic), txt))))));
}

// ---------- Inicio por rol ----------
function inicioSupervisor(yo) {
  return el("div", { class: "shell-patron" }, menuSimple([["tablero", "Tablero"]]),
    el("main", { class: "contenido" }, encabezado(yo, yo.empresa?.nombre),
      aviso("azul", "Tu tablero de supervisor se conecta en una fase siguiente.")));
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
        `Empresa creada. Clave para sus trabajadores: ${r.clave}.`,
        el("small", { texto: r.correoEnviado ? "El administrador recibirá un correo para crear su contraseña." : "No se pudo enviar el correo; el administrador puede usar «Olvidé mi contraseña»." }))));
    } catch (e) {
      const txt = e.codigo === "correo_existente" ? "Ese correo ya tiene cuenta." : mensajeErrorApi(e, "No se pudo crear la empresa.");
      resultado.append(aviso("rojo", txt));
    } finally {
      cargando(enviar, false);
    }
  });
  return el("div", { class: "shell-patron" }, menuSimple([["edificio", "Empresas"]]),
    el("main", { class: "contenido" }, encabezado(yo, "Diagonal Catorce"),
      el("section", { class: "tarjeta" },
        el("div", { class: "tarjeta__cabecera" }, el("h2", { class: "tarjeta__titulo", texto: "Nueva empresa" }), el("span", { class: "pildora pildora--violeta", texto: "Superadmin" })),
        form, resultado)));
}

async function inicioTrabajador(yo) {
  document.body.classList.add("con-menu-inferior");
  const nombre = (yo.nombre || "").split(/\s+/)[0];
  const ficha = await datos.miFicha(yo.empresa.id, yo.uid).catch(() => null);
  const sitios = ficha ? await datos.sitios(yo.empresa.id).catch(() => []) : [];
  const fotoUrl = ficha?.foto?.id ? await imagenPrivada(`/v1/trabajadores/foto?id=${ficha.id}`) : null;
  const nombreSitio = Object.fromEntries(sitios.map((s) => [s.id, s.nombre]));
  const opciones = [["inicio", "Inicio"], ["historial", "Historial"], ["mi-horario", "Mi horario"], ["perfil", "Perfil"]];
  const gafete = ficha?.gafete?.estado || "ninguno";
  return el("div", { class: "shell-trabajador" },
    el("header", { class: "encabezado-trab" },
      el("div", {}, el("p", { class: "secundario", texto: yo.empresa?.nombre || "" }), el("h1", { class: "titulo-grande", texto: `Hola${nombre ? `, ${nombre}` : ""}` })),
      fotoUrl ? el("img", { class: "avatar avatar--lg avatar--foto", src: fotoUrl, alt: "" }) : el("span", { class: "avatar avatar--lg", "aria-hidden": "true", texto: iniciales(yo.nombre) })),
    el("main", { class: "contenido-trab" },
      ficha ? el("section", { class: "tarjeta" },
        el("dl", { class: "ficha__datos" },
          el("dt", { texto: "Número" }), el("dd", { texto: ficha.numero }),
          el("dt", { texto: "Sitios" }), el("dd", { texto: (ficha.sucursales || []).map((s) => nombreSitio[s] || "—").join(", ") }),
          el("dt", { texto: "Gafete" }), el("dd", {}, el("span", { class: `pildora pildora--${gafete === "activo" ? "verde" : gafete === "revocado" ? "rojo" : "blanca"}`, texto: gafete === "activo" ? "Activo" : gafete === "revocado" ? "Revocado: checa con número y PIN" : "Sin gafete" })))) : null,
      aviso("azul", "El botón para checar tu entrada y salida se activa en la siguiente fase."),
      el("div", { class: "fila-fin" }, botonSalir())),
    el("nav", { class: "menu-inferior", "aria-label": "Menú" },
      el("ul", {}, opciones.map(([ic, txt], i) => el("li", {},
        el("span", { class: "menu-inferior__item", "aria-current": i === 0 ? "page" : null },
          el("span", { class: "menu-inferior__pastilla" }, icono(ic)), txt))))));
}

function sinAcceso(texto) {
  return el("main", { class: "pantalla-centro" },
    el("section", { class: "tarjeta login" }, logo(),
      aviso("ambar", texto),
      el("button", { class: "boton boton--primario boton--bloque", type: "button", onclick: () => salir() }, "Volver al inicio")));
}

// ---------- Sesión ----------
alCambiarSesion(async (usuario) => {
  desmontarAdmin();
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
    mostrarPantalla("app");
    if (yo.rol === "admin_empresa") return await montarAdmin(yo, app);
    const vista = yo.rol === "superadmin" ? inicioSuperadmin(yo) : yo.rol === "trabajador" ? await inicioTrabajador(yo) : inicioSupervisor(yo);
    app.replaceChildren(vista);
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
