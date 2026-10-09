// Panel del administrador de la empresa (Fase 1): tablero, trabajadores, sitios, configuración y credencial.
// Lecturas: Firestore (protegidas por las reglas). Escrituras: SIEMPRE por el Worker.
// El PIN y el código del gafete solo existen en pantalla el momento en que se generan; no se guardan en el navegador.
import { api, imagenPrivada, mensajeErrorApi, subirImagen } from "./api.js";
import { comprimir, elegirImagen } from "./camara.js";
import { credencial } from "./credencial.js";
import * as datos from "./datos.js";
import { salir } from "./auth.js";
import { cargando, el, fechaLarga, icono, iniciales, saludo } from "./ui.js";

export const CONSENTIMIENTO_FOTO = "foto-alta-2026-10-v1";
const TEXTO_CONSENTIMIENTO = [
  "La foto del trabajador se usa solo para identificarlo en su credencial y para que la empresa la compare con las selfies de registro.",
  "Se guarda en almacenamiento privado: solo la ven el administrador de la empresa y el propio trabajador. No se usa reconocimiento facial.",
  "El trabajador puede pedir en cualquier momento que se consulte, corrija o elimine.",
];
const MODOS = { telefono: "Teléfono", quiosco: "Quiosco", ambos: "Teléfono y quiosco" };
const RADIOS = [50, 100, 150, 200, 300, 500, 1000];

let ctx = null; // { yo, empresaId, raiz, contenido, empresa, sitios, objetos: [] }
let credencialPendiente = null; // { trabajadorId, codigo } — solo en memoria, se borra al salir de la vista

// ---------- utilidades de vista ----------
const aviso = (tipo, texto, ic = tipo === "rojo" ? "alerta" : tipo === "verde" ? "check" : "info") =>
  el("div", { class: `aviso aviso--${tipo}`, role: tipo === "rojo" ? "alert" : "status" }, icono(ic), el("div", { class: "aviso__texto", texto }));
const ir = (ruta) => { location.hash = ruta; };
const enlace = (ruta, ...hijos) => el("a", { href: `#${ruta}` }, ...hijos);

function campo(id, etiqueta, attrs = {}) {
  return el("div", { class: "campo" }, el("label", { for: id, texto: etiqueta }), el("input", { id, name: id, autocomplete: "off", ...attrs }));
}
function valor(form, id) { return form.querySelector(`#${id}`).value.trim(); }

// Libera las imágenes blob: de la vista anterior.
function limpiarObjetos() {
  for (const u of ctx.objetos) URL.revokeObjectURL(u);
  ctx.objetos = [];
}
async function imagen(ruta) {
  const u = await imagenPrivada(ruta);
  if (u) ctx.objetos.push(u);
  return u;
}

function encabezado(titulo, sub, acciones = []) {
  return el("header", { class: "encabezado" },
    el("div", {}, el("p", { class: "secundario", texto: sub }), el("h1", { class: "titulo-grande", texto: titulo })),
    el("div", { class: "encabezado__acciones" }, ...acciones));
}

async function recargarEmpresa() {
  ctx.empresa = await datos.empresa(ctx.empresaId);
  ctx.sitios = await datos.sitios(ctx.empresaId);
}

const pildoraGafete = (g) => {
  const e = g?.estado || "ninguno";
  return el("span", { class: `pildora pildora--${e === "activo" ? "verde" : e === "revocado" ? "rojo" : "blanca"}`, texto: e === "activo" ? "Gafete activo" : e === "revocado" ? "Gafete revocado" : "Sin gafete" });
};

// ---------- menú ----------
const OPCIONES = [
  ["/", "tablero", "Tablero"],
  [null, "registros", "Registros"],
  ["/trabajadores", "trabajadores", "Trabajadores"],
  ["/sitios", "ubicacion", "Sitios"],
  [null, "horarios", "Horarios"],
  [null, "reporte", "Reportes STPS"],
  [null, "convenio", "Convenios"],
  ["/configuracion", "config", "Configuración"],
];
function menu(rutaActual) {
  const seccion = "/" + (rutaActual.split("/")[1] || "");
  const activa = (r) => r === seccion || (r === "/trabajadores" && ["/trabajador", "/credencial"].includes(seccion)) || (r === "/sitios" && seccion === "/sitio");
  return el("aside", { class: "menu-lateral" },
    el("div", { class: "logo" }, el("span", { class: "logo__marca" }, icono("reloj")),
      el("span", {}, el("span", { class: "logo__nombre", texto: "Horario Laboral" }), el("br"), el("span", { class: "logo__por", texto: "por Diagonal Catorce" }))),
    el("nav", { "aria-label": "Menú principal" },
      el("ul", {}, OPCIONES.map(([r, ic, txt]) => el("li", {},
        r ? el("a", { class: "menu-lateral__item", href: `#${r}`, "aria-current": activa(r) ? "page" : null }, icono(ic), txt)
          : el("span", { class: "menu-lateral__item menu-lateral__item--pronto", title: "Próximamente" }, icono(ic), txt, el("small", { texto: "Pronto" })))))),
    el("div", { class: "menu-lateral__pie" },
      el("div", { class: "tarjeta-lft" }, el("span", { class: "cuadro cuadro--azul cuadro--sm" }, icono("escudo", "ic-sm")),
        el("strong", { texto: "Cumplimiento LFT" }), el("p", { texto: "Registro electrónico obligatorio desde el 1 de enero de 2027." })),
      el("button", { class: "boton boton--bloque", type: "button", onclick: () => salir() }, icono("salir", "ic-sm"), "Salir")));
}

// ---------- vistas ----------
async function vistaTablero() {
  const ts = await datos.trabajadores(ctx.empresaId);
  const activos = ts.filter((t) => t.activo);
  const conGafete = activos.filter((t) => t.gafete?.estado === "activo").length;
  const nombre = (ctx.yo.nombre || "").split(/\s+/)[0];
  const kpi = (ic, color, cifra, txt) => el("article", { class: "tarjeta indicador" },
    el("span", { class: `cuadro cuadro--${color}` }, icono(ic)), el("span", { class: "indicador__cifra", texto: String(cifra) }), el("span", { class: "indicador__texto", texto: txt }));
  return [
    encabezado(`${saludo()}${nombre ? `, ${nombre}` : ""}`, `${fechaLarga()} · ${ctx.empresa.nombre}`, [
      el("a", { class: "boton", href: "#/sitios/nuevo" }, icono("ubicacion", "ic-sm"), "Agregar sitio"),
      el("a", { class: "boton boton--primario", href: "#/trabajadores/nuevo" }, icono("agregar-persona", "ic-sm"), "Agregar trabajador"),
    ]),
    el("div", { class: "indicadores indicadores--4" },
      kpi("trabajadores", "turquesa", ctx.empresa.empleadosActivos || 0, "Trabajadores activos"),
      kpi("ubicacion", "azul", ctx.empresa.sitiosActivos || 0, "Sitios activos"),
      kpi("qr", "verde", conGafete, "Con gafete activo"),
      kpi("alerta", "ambar", activos.length - conGafete, "Sin gafete")),
    tarjetaClave(),
    aviso("azul", "Los registros de entrada y salida, horarios y reportes STPS se activan en las siguientes fases."),
  ];
}

function tarjetaClave() {
  return el("section", { class: "tarjeta clave-empresa" },
    el("div", {}, el("h2", { class: "tarjeta__titulo", texto: "Clave de tu empresa" }),
      el("p", { class: "secundario", texto: "Tus trabajadores entran a la app con esta clave, su número de empleado y su PIN." })),
    el("span", { class: "clave-empresa__valor", texto: ctx.empresa.clave || "—" }));
}

async function vistaTrabajadores() {
  const ts = await datos.trabajadores(ctx.empresaId);
  const nombreSitio = Object.fromEntries(ctx.sitios.map((s) => [s.id, s.nombre]));
  const buscador = el("input", { type: "search", class: "buscador", placeholder: "Buscar por nombre o número", "aria-label": "Buscar trabajador" });
  const lista = el("ul", { class: "lista lista--tarjetas" });
  const pintar = () => {
    const q = buscador.value.trim().toLowerCase();
    const vis = ts.filter((t) => !q || `${t.nombre} ${t.apellidos} ${t.numero}`.toLowerCase().includes(q));
    lista.replaceChildren(...(vis.length ? vis.map((t) => el("li", {},
      el("a", { class: "fila-trabajador", href: `#/trabajador/${t.id}` },
        el("span", { class: "avatar", "aria-hidden": "true", texto: iniciales(`${t.nombre} ${t.apellidos}`) }),
        el("span", { class: "lista__cuerpo" },
          el("span", { class: "lista__titulo", texto: `${t.nombre} ${t.apellidos}` }),
          el("span", { class: "lista__sub", texto: `No. ${t.numero} · ${MODOS[t.modo] || ""} · ${(t.sucursales || []).map((s) => nombreSitio[s] || "—").join(", ")}` })),
        el("span", { class: "fila-trabajador__pildoras" },
          t.activo ? pildoraGafete(t.gafete) : el("span", { class: "pildora pildora--rojo", texto: "Baja" })))))
      : [el("li", { class: "vacio", texto: ts.length ? "Nadie coincide con la búsqueda." : "Aún no hay trabajadores. Agrega el primero." })]));
  };
  buscador.addEventListener("input", pintar);
  pintar();
  return [
    encabezado("Trabajadores", `${ctx.empresa.empleadosActivos || 0} activos · ${ctx.empresa.nombre}`, [
      el("a", { class: "boton boton--primario", href: "#/trabajadores/nuevo" }, icono("agregar-persona", "ic-sm"), "Agregar trabajador")]),
    el("section", { class: "tarjeta" }, buscador, lista),
  ];
}

function selectorSitios(seleccion = []) {
  const activos = ctx.sitios.filter((s) => s.activo);
  if (!activos.length) return aviso("ambar", "Primero da de alta al menos un sitio de trabajo (menú Sitios).");
  return el("fieldset", { class: "grupo-opciones" }, el("legend", { texto: "Sitios donde trabaja" }),
    ...activos.map((s) => el("label", { class: "opcion" },
      el("input", { type: "checkbox", name: "sitio", value: s.id, checked: seleccion.includes(s.id) }), el("span", { texto: s.nombre }))));
}
function selectorModo(actual = "ambos") {
  return el("fieldset", { class: "grupo-opciones" }, el("legend", { texto: "Cómo registra su asistencia" }),
    ...Object.entries(MODOS).map(([v, txt]) => el("label", { class: "opcion" },
      el("input", { type: "radio", name: "modo", value: v, checked: v === actual }), el("span", { texto: txt }))));
}
const sitiosElegidos = (form) => [...form.querySelectorAll("input[name=sitio]:checked")].map((i) => i.value);
const modoElegido = (form) => form.querySelector("input[name=modo]:checked")?.value;

function formularioTrabajador(t, { alta }) {
  const form = el("form", { class: "formulario formulario--2", novalidate: true },
    alta ? campo("numero", "Número de empleado", { required: true, maxlength: 12, autocapitalize: "characters", placeholder: "Ej. G-001" }) : null,
    campo("nombre", "Nombre(s)", { required: true, maxlength: 60, value: t?.nombre || "" }),
    campo("apellidos", "Apellidos", { required: true, maxlength: 80, value: t?.apellidos || "" }),
    campo("fechaNacimiento", "Fecha de nacimiento", { type: "date", required: true, value: t?.fechaNacimiento || "", max: new Date().toISOString().slice(0, 10) }),
    el("div", { class: "formulario__ancho" }, selectorSitios(t?.sucursales || (ctx.sitios.filter((s) => s.activo).length === 1 ? [ctx.sitios.find((s) => s.activo).id] : []))),
    el("div", { class: "formulario__ancho" }, selectorModo(t?.modo)),
  );
  if (alta) {
    form.append(el("div", { class: "formulario__ancho consentimiento" },
      el("h3", { texto: "Consentimiento para la foto" }),
      ...TEXTO_CONSENTIMIENTO.map((p) => el("p", { class: "secundario", texto: p })),
      el("p", { class: "consentimiento__nota", texto: "Texto provisional, pendiente de validar con el abogado." }),
      el("label", { class: "opcion" }, el("input", { type: "checkbox", id: "consiente" }),
        el("span", { texto: "El trabajador leyó este aviso y acepta que se le tome la foto." }))));
  }
  return form;
}

function vistaAlta() {
  const resultado = el("div");
  const form = formularioTrabajador(null, { alta: true });
  const enviar = el("button", { class: "boton boton--primario", type: "submit" }, icono("agregar-persona", "ic-sm"), "Dar de alta");
  form.append(el("div", { class: "formulario__fin" }, el("a", { class: "boton", href: "#/trabajadores", texto: "Cancelar" }), enviar));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    resultado.replaceChildren();
    const consiente = form.querySelector("#consiente").checked;
    cargando(enviar, true);
    try {
      const r = await api("POST", "/v1/trabajadores", {
        numero: valor(form, "numero"), nombre: valor(form, "nombre"), apellidos: valor(form, "apellidos"),
        fechaNacimiento: valor(form, "fechaNacimiento"), sucursales: sitiosElegidos(form), modo: modoElegido(form),
        consentimientoFoto: consiente ? { aceptado: true, version: CONSENTIMIENTO_FOTO } : null,
      });
      await recargarEmpresa();
      form.replaceWith(pasoDespuesDelAlta(r, consiente, `${valor(form, "nombre")}`));
    } catch (e) {
      resultado.append(aviso("rojo", mensajeErrorApi(e, "No se pudo dar de alta.")));
    } finally {
      cargando(enviar, false);
    }
  });
  return [encabezado("Nuevo trabajador", ctx.empresa.nombre), el("section", { class: "tarjeta" }, form, resultado)];
}

// Paso 2 del alta: PIN (una sola vez), foto y credencial.
function pasoDespuesDelAlta(r, consiente, nombre) {
  const caja = el("div", { class: "pasos-alta" });
  caja.append(
    aviso("verde", `${nombre} quedó dado de alta.`),
    el("div", { class: "pin-unico" },
      el("span", { class: "secundario", texto: "PIN personal (6 dígitos)" }),
      el("span", { class: "pin-unico__valor", texto: r.pin }),
      el("p", { class: "secundario", texto: "Entrégaselo al trabajador ahora. No se vuelve a mostrar; si lo olvida, restablécelo desde su ficha." })),
  );
  const acciones = el("div", { class: "formulario__fin" });
  if (consiente) acciones.append(botonFoto(r.id, (url) => caja.querySelector(".pin-unico").after(el("img", { class: "foto-previa", src: url, alt: "Foto del trabajador" }))));
  acciones.append(
    el("button", { class: "boton boton--primario", type: "button", onclick: (ev) => emitirYMostrar(r.id, ev.currentTarget) }, icono("qr", "ic-sm"), "Emitir credencial"),
    el("a", { class: "boton", href: `#/trabajador/${r.id}`, texto: "Ver ficha" }));
  caja.append(acciones);
  return caja;
}

function botonFoto(trabajadorId, alListo) {
  const b = el("button", { class: "boton", type: "button" }, icono("camara", "ic-sm"), "Tomar foto");
  b.addEventListener("click", async () => {
    const archivo = await elegirImagen({ camara: "user" });
    if (!archivo) return;
    cargando(b, true);
    try {
      const blob = await comprimir(archivo, { ladoMax: 600, tipo: "image/jpeg" });
      await subirImagen(`/v1/trabajadores/foto?id=${trabajadorId}`, blob);
      const url = URL.createObjectURL(blob);
      ctx.objetos.push(url);
      alListo?.(url);
      b.replaceChildren(icono("check", "ic-sm"), "Foto guardada");
    } catch (e) {
      b.after(aviso("rojo", e.message === "imagen_muy_grande" ? "La foto es demasiado grande." : mensajeErrorApi(e, "No se pudo guardar la foto.")));
    } finally {
      cargando(b, false);
    }
  });
  return b;
}

async function emitirYMostrar(trabajadorId, boton) {
  cargando(boton, true);
  try {
    const r = await api("POST", "/v1/trabajadores/gafete", { id: trabajadorId });
    credencialPendiente = { trabajadorId, codigo: r.codigo };
    ir(`/credencial/${trabajadorId}`);
  } catch (e) {
    boton.after(aviso("rojo", mensajeErrorApi(e, "No se pudo emitir la credencial.")));
  } finally {
    cargando(boton, false);
  }
}

async function vistaTrabajador(id) {
  const t = await datos.trabajador(ctx.empresaId, id);
  if (!t) return [aviso("rojo", "Ese trabajador no existe.")];
  const nombreSitio = Object.fromEntries(ctx.sitios.map((s) => [s.id, s.nombre]));
  const fotoUrl = t.foto?.id ? await imagen(`/v1/trabajadores/foto?id=${id}`) : null;
  const mensajes = el("div");
  const accion = (texto, ic, clase, fn, confirmar) => {
    const b = el("button", { class: `boton ${clase}`, type: "button" }, icono(ic, "ic-sm"), texto);
    b.addEventListener("click", async () => {
      if (confirmar && !window.confirm(confirmar)) return;
      mensajes.replaceChildren();
      cargando(b, true);
      try { await fn(b); } catch (e) { mensajes.append(aviso("rojo", mensajeErrorApi(e))); } finally { cargando(b, false); }
    });
    return b;
  };
  const recargar = async () => { await recargarEmpresa(); await mostrar(); };
  const acciones = el("div", { class: "acciones-ficha" });
  if (t.activo) {
    acciones.append(
      el("a", { class: "boton", href: `#/trabajador/${id}/editar` }, icono("config", "ic-sm"), "Editar"),
      t.consentimientoFoto ? botonFoto(id, () => recargar()) : null,
      accion(t.gafete?.estado === "activo" ? "Reimprimir credencial" : "Emitir credencial", "qr", "boton--primario",
        (b) => emitirYMostrar(id, b),
        t.gafete?.estado === "activo" ? "Se generará un gafete nuevo y el actual dejará de servir. ¿Continuar?" : null),
      t.gafete?.estado === "activo" ? accion("Revocar gafete (perdido)", "cerrar", "boton--peligro", async () => {
        await api("POST", "/v1/trabajadores/gafete/revocar", { id });
        await recargar();
      }, "El gafete actual dejará de servir de inmediato. Mientras tanto, el trabajador puede checar con su número y PIN. ¿Revocar?") : null,
      accion("Restablecer PIN", "escudo", "", async () => {
        const r = await api("POST", "/v1/trabajadores/pin", { id });
        mensajes.append(el("div", { class: "pin-unico" }, el("span", { class: "secundario", texto: "PIN nuevo" }),
          el("span", { class: "pin-unico__valor", texto: r.pin }), el("p", { class: "secundario", texto: "Entrégalo ahora: no se vuelve a mostrar. El PIN anterior ya no sirve." })));
      }, "Se generará un PIN nuevo y el anterior dejará de servir. ¿Continuar?"),
      accion("Dar de baja", "ausencias", "boton--peligro", async () => {
        await api("POST", "/v1/trabajadores/estado", { id, activo: false });
        await recargar();
      }, `¿Dar de baja a ${t.nombre}? Se revoca su gafete y ya no podrá entrar.`),
    );
  } else {
    acciones.append(accion("Reactivar", "presentes", "boton--primario", async () => {
      await api("POST", "/v1/trabajadores/estado", { id, activo: true });
      await recargar();
    }, `¿Reactivar a ${t.nombre}? Necesitará una credencial nueva.`));
  }
  return [
    encabezado(`${t.nombre} ${t.apellidos}`, `No. ${t.numero} · ${ctx.empresa.nombre}`, [el("a", { class: "boton", href: "#/trabajadores", texto: "Volver" })]),
    el("section", { class: "tarjeta ficha" },
      fotoUrl ? el("img", { class: "ficha__foto", src: fotoUrl, alt: "Foto del trabajador" }) : el("span", { class: "avatar avatar--xl", "aria-hidden": "true", texto: iniciales(`${t.nombre} ${t.apellidos}`) }),
      el("dl", { class: "ficha__datos" },
        el("dt", { texto: "Estado" }), el("dd", {}, el("span", { class: `pildora pildora--${t.activo ? "verde" : "rojo"}`, texto: t.activo ? "Activo" : "Baja" }), " ", pildoraGafete(t.gafete)),
        el("dt", { texto: "Registro" }), el("dd", { texto: MODOS[t.modo] || "—" }),
        el("dt", { texto: "Sitios" }), el("dd", { texto: (t.sucursales || []).map((s) => nombreSitio[s] || "—").join(", ") }),
        el("dt", { texto: "Nacimiento" }), el("dd", { texto: t.fechaNacimiento }),
        el("dt", { texto: "Foto" }), el("dd", { texto: t.consentimientoFoto ? (t.foto ? "Con consentimiento · tomada" : "Con consentimiento · pendiente") : "Sin consentimiento (no se puede tomar)" }))),
    el("section", { class: "tarjeta" }, el("h2", { class: "tarjeta__titulo", texto: "Acciones" }), acciones, mensajes),
  ];
}

async function vistaEditarTrabajador(id) {
  const t = await datos.trabajador(ctx.empresaId, id);
  if (!t) return [aviso("rojo", "Ese trabajador no existe.")];
  const resultado = el("div");
  const form = formularioTrabajador(t, { alta: false });
  const guardar = el("button", { class: "boton boton--primario", type: "submit", texto: "Guardar cambios" });
  form.append(el("div", { class: "formulario__fin" }, el("a", { class: "boton", href: `#/trabajador/${id}`, texto: "Cancelar" }), guardar));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    resultado.replaceChildren();
    cargando(guardar, true);
    try {
      await api("POST", "/v1/trabajadores/editar", {
        id, nombre: valor(form, "nombre"), apellidos: valor(form, "apellidos"), fechaNacimiento: valor(form, "fechaNacimiento"),
        sucursales: sitiosElegidos(form), modo: modoElegido(form),
      });
      ir(`/trabajador/${id}`);
    } catch (e) {
      resultado.append(aviso("rojo", mensajeErrorApi(e, "No se pudo guardar.")));
    } finally {
      cargando(guardar, false);
    }
  });
  return [encabezado("Editar trabajador", `No. ${t.numero} (el número no se puede cambiar)`), el("section", { class: "tarjeta" }, form, resultado)];
}

async function vistaCredencial(id) {
  const pendiente = credencialPendiente?.trabajadorId === id ? credencialPendiente : null;
  if (!pendiente) {
    return [encabezado("Credencial", ctx.empresa.nombre),
      aviso("ambar", "Por seguridad, el código del gafete solo se muestra al emitirlo. Desde la ficha del trabajador puedes emitir uno nuevo (el anterior deja de servir)."),
      el("a", { class: "boton", href: `#/trabajador/${id}`, texto: "Ir a la ficha" })];
  }
  const t = await datos.trabajador(ctx.empresaId, id);
  const [fotoUrl, logoUrl] = await Promise.all([
    t.foto?.id ? imagen(`/v1/trabajadores/foto?id=${id}`) : null,
    ctx.empresa.logo?.id ? imagen("/v1/empresa/logo") : null,
  ]);
  const tarjeta = credencial({ empresa: ctx.empresa, trabajador: t, codigo: pendiente.codigo, fotoUrl, logoUrl });
  return [
    encabezado("Credencial lista", `${t.nombre} ${t.apellidos} · No. ${t.numero}`),
    aviso("ambar", "Imprímela ahora: el código no se vuelve a mostrar. Tamaño CR80 (54 × 85.6 mm). En la ventana de impresión elige escala 100 %."),
    el("div", { class: "credencial-zona" }, tarjeta),
    el("div", { class: "formulario__fin" },
      el("button", { class: "boton boton--primario", type: "button", onclick: () => window.print() }, icono("descargar", "ic-sm"), "Imprimir"),
      el("a", { class: "boton", href: `#/trabajador/${id}`, texto: "Listo" })),
  ];
}

async function vistaSitios() {
  const lista = el("ul", { class: "lista lista--tarjetas" });
  const mensajes = el("div");
  lista.replaceChildren(...(ctx.sitios.length ? ctx.sitios.map((s) => {
    const cambiar = el("button", { class: `boton ${s.activo ? "boton--peligro" : ""}`, type: "button", texto: s.activo ? "Desactivar" : "Reactivar" });
    cambiar.addEventListener("click", async () => {
      if (s.activo && !window.confirm(`¿Desactivar "${s.nombre}"? No se podrá asignar a nuevos trabajadores.`)) return;
      cargando(cambiar, true);
      try {
        await api("POST", "/v1/sitios/estado", { id: s.id, activo: !s.activo });
        await recargarEmpresa();
        await mostrar();
      } catch (e) {
        mensajes.replaceChildren(aviso("rojo", mensajeErrorApi(e)));
        cargando(cambiar, false);
      }
    });
    return el("li", { class: "fila-sitio" },
      el("span", { class: "cuadro cuadro--azul" }, icono("ubicacion")),
      el("span", { class: "lista__cuerpo" },
        el("span", { class: "lista__titulo", texto: s.nombre }),
        el("span", { class: "lista__sub", texto: `${s.direccion || "Sin dirección"} · zona de ${s.radioM} m` })),
      el("span", { class: `pildora pildora--${s.activo ? "verde" : "rojo"}`, texto: s.activo ? "Activo" : "Inactivo" }),
      el("a", { class: "boton", href: `#/sitio/${s.id}/editar`, texto: "Editar" }), cambiar);
  }) : [el("li", { class: "vacio", texto: "Aún no hay sitios. Agrega el primero (planta, oficina, obra o punto de servicio)." })]));
  return [
    encabezado("Sitios", `${ctx.empresa.sitiosActivos || 0} activos · ${ctx.empresa.nombre}`, [
      el("a", { class: "boton boton--primario", href: "#/sitios/nuevo" }, icono("ubicacion", "ic-sm"), "Agregar sitio")]),
    el("section", { class: "tarjeta" }, lista, mensajes),
  ];
}

function vistaSitioForm(id) {
  const s = id ? ctx.sitios.find((x) => x.id === id) : null;
  if (id && !s) return [aviso("rojo", "Ese sitio no existe.")];
  const resultado = el("div");
  const precision = el("p", { class: "secundario", "aria-live": "polite" });
  const radio = el("select", { id: "radioM", name: "radioM" }, ...RADIOS.map((r) => el("option", { value: String(r), selected: (s?.radioM || 150) === r, texto: `${r} m` })));
  const form = el("form", { class: "formulario formulario--2", novalidate: true },
    campo("nombre", "Nombre del sitio", { required: true, maxlength: 80, value: s?.nombre || "", placeholder: "Ej. Planta Norte" }),
    campo("direccion", "Dirección (opcional)", { maxlength: 200, value: s?.direccion || "" }),
    campo("lat", "Latitud", { inputmode: "decimal", required: true, value: s ? String(s.lat) : "" }),
    campo("lng", "Longitud", { inputmode: "decimal", required: true, value: s ? String(s.lng) : "" }),
    el("div", { class: "campo" }, el("label", { for: "radioM", texto: "Zona permitida (radio)" }), radio),
  );
  const ubicar = el("button", { class: "boton", type: "button" }, icono("ubicacion", "ic-sm"), "Usar mi ubicación actual");
  ubicar.addEventListener("click", () => {
    if (!navigator.geolocation) { precision.textContent = "Este dispositivo no permite obtener la ubicación."; return; }
    cargando(ubicar, true);
    navigator.geolocation.getCurrentPosition((p) => {
      form.querySelector("#lat").value = p.coords.latitude.toFixed(6);
      form.querySelector("#lng").value = p.coords.longitude.toFixed(6);
      precision.textContent = `Ubicación tomada con precisión de ±${Math.round(p.coords.accuracy)} m. Hazlo parado en el sitio.`;
      cargando(ubicar, false);
    }, () => {
      precision.textContent = "No se pudo obtener la ubicación. Revisa el permiso o escribe las coordenadas.";
      cargando(ubicar, false);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
  const guardar = el("button", { class: "boton boton--primario", type: "submit", texto: s ? "Guardar cambios" : "Agregar sitio" });
  form.append(el("div", { class: "formulario__ancho" }, ubicar, precision),
    el("div", { class: "formulario__fin" }, el("a", { class: "boton", href: "#/sitios", texto: "Cancelar" }), guardar));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    resultado.replaceChildren();
    const lat = Number(valor(form, "lat").replace(",", ".")), lng = Number(valor(form, "lng").replace(",", "."));
    cargando(guardar, true);
    try {
      const cuerpo = { nombre: valor(form, "nombre"), direccion: valor(form, "direccion"), lat, lng, radioM: Number(radio.value) };
      await api("POST", s ? "/v1/sitios/editar" : "/v1/sitios", s ? { id: s.id, ...cuerpo } : cuerpo);
      await recargarEmpresa();
      ir("/sitios");
    } catch (e) {
      resultado.append(aviso("rojo", mensajeErrorApi(e, "No se pudo guardar el sitio.")));
    } finally {
      cargando(guardar, false);
    }
  });
  return [encabezado(s ? "Editar sitio" : "Nuevo sitio", ctx.empresa.nombre), el("section", { class: "tarjeta" }, form, resultado)];
}

async function vistaConfiguracion() {
  const e = ctx.empresa;
  const mesActual = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 7);
  const consumo = await datos.consumo(ctx.empresaId, mesActual);
  const logoUrl = e.logo?.id ? await imagen("/v1/empresa/logo") : null;
  const mensajes = el("div");

  // Marca
  const c1 = el("input", { type: "color", id: "colorPrimario", value: e.marca?.colorPrimario || "#0F9D94" });
  const c2 = el("input", { type: "color", id: "colorSecundario", value: e.marca?.colorSecundario || "#183153" });
  const guardarMarca = el("button", { class: "boton boton--primario", type: "button", texto: "Guardar colores" });
  guardarMarca.addEventListener("click", async () => {
    cargando(guardarMarca, true);
    try {
      await api("POST", "/v1/empresa/marca", { colorPrimario: c1.value, colorSecundario: c2.value });
      await recargarEmpresa();
      mensajes.replaceChildren(aviso("verde", "Colores guardados. Se usan en las credenciales nuevas."));
    } catch (err) { mensajes.replaceChildren(aviso("rojo", mensajeErrorApi(err))); } finally { cargando(guardarMarca, false); }
  });
  const cambiarLogo = el("button", { class: "boton", type: "button" }, icono("descargar", "ic-sm"), logoUrl ? "Cambiar logo" : "Subir logo");
  cambiarLogo.addEventListener("click", async () => {
    const archivo = await elegirImagen({ camara: null, tipos: "image/png,image/jpeg" });
    if (!archivo) return;
    cargando(cambiarLogo, true);
    try {
      const blob = await comprimir(archivo, { ladoMax: 400, tipo: archivo.type === "image/png" ? "image/png" : "image/jpeg", maxBytes: 190 * 1024 });
      await subirImagen("/v1/empresa/logo", blob);
      await recargarEmpresa();
      await mostrar();
    } catch (err) {
      mensajes.replaceChildren(aviso("rojo", err.message === "imagen_muy_grande" ? "El logo es demasiado pesado (máx. 200 KB)." : mensajeErrorApi(err)));
      cargando(cambiarLogo, false);
    }
  });

  // Gafete + PIN
  const pinCon = el("input", { type: "checkbox", id: "pinConGafete", checked: !!e.config?.pinConGafete });
  pinCon.addEventListener("change", async () => {
    pinCon.disabled = true;
    try {
      await api("POST", "/v1/empresa/config", { pinConGafete: pinCon.checked });
      await recargarEmpresa();
      mensajes.replaceChildren(aviso("verde", "Configuración guardada."));
    } catch (err) {
      pinCon.checked = !pinCon.checked;
      mensajes.replaceChildren(aviso("rojo", mensajeErrorApi(err)));
    } finally { pinCon.disabled = false; }
  });

  return [
    encabezado("Configuración", e.nombre),
    mensajes,
    tarjetaClave(),
    el("section", { class: "tarjeta" }, el("h2", { class: "tarjeta__titulo", texto: "Marca de la credencial" }),
      el("div", { class: "marca" },
        logoUrl ? el("img", { class: "marca__logo", src: logoUrl, alt: "Logo de la empresa" }) : el("span", { class: "marca__logo marca__logo--vacio", texto: "Sin logo" }),
        el("div", { class: "marca__colores" },
          el("label", { class: "opcion", for: "colorPrimario" }, c1, el("span", { texto: "Color principal" })),
          el("label", { class: "opcion", for: "colorSecundario" }, c2, el("span", { texto: "Color secundario" })))),
      el("p", { class: "secundario", texto: "Logo PNG o JPG de hasta 200 KB." }),
      el("div", { class: "formulario__fin" }, cambiarLogo, guardarMarca)),
    el("section", { class: "tarjeta" }, el("h2", { class: "tarjeta__titulo", texto: "Gafete" }),
      el("label", { class: "opcion" }, pinCon, el("span", { texto: "Pedir también el PIN al checar con gafete en el quiosco (más seguro, un paso más)." }))),
    el("section", { class: "tarjeta" }, el("h2", { class: "tarjeta__titulo", texto: "Uso de este mes" }),
      el("dl", { class: "ficha__datos" },
        el("dt", { texto: "Trabajadores activos hoy" }), el("dd", { texto: String(e.empleadosActivos || 0) }),
        el("dt", { texto: "Máximo del mes" }), el("dd", { texto: String(consumo?.maxEmpleados ?? e.empleadosActivos ?? 0) }),
        el("dt", { texto: "Sitios activos hoy" }), el("dd", { texto: String(e.sitiosActivos || 0) }),
        el("dt", { texto: "Máximo de sitios del mes" }), el("dd", { texto: String(consumo?.maxSitios ?? e.sitiosActivos ?? 0) })),
      el("p", { class: "secundario", texto: "Estos números se usarán para el cobro (base + trabajador + sitio)." })),
  ];
}

// ---------- enrutador ----------
async function mostrar() {
  const ruta = location.hash.replace(/^#/, "") || "/";
  // El código del gafete solo vive mientras se está en su credencial.
  if (!ruta.startsWith("/credencial/")) credencialPendiente = null;
  limpiarObjetos();
  const p = ruta.split("/").filter(Boolean);
  const cuerpo = el("main", { class: "contenido", "aria-busy": "true" });
  ctx.raiz.replaceChildren(el("div", { class: "shell-patron" }, menu(ruta), cuerpo));
  document.body.classList.toggle("vista-credencial", p[0] === "credencial");
  let vista;
  try {
    if (!p.length) vista = await vistaTablero();
    else if (p[0] === "trabajadores" && p[1] === "nuevo") vista = vistaAlta();
    else if (p[0] === "trabajadores") vista = await vistaTrabajadores();
    else if (p[0] === "trabajador" && p[2] === "editar") vista = await vistaEditarTrabajador(p[1]);
    else if (p[0] === "trabajador") vista = await vistaTrabajador(p[1]);
    else if (p[0] === "credencial") vista = await vistaCredencial(p[1]);
    else if (p[0] === "sitios" && p[1] === "nuevo") vista = vistaSitioForm(null);
    else if (p[0] === "sitios") vista = await vistaSitios();
    else if (p[0] === "sitio" && p[2] === "editar") vista = vistaSitioForm(p[1]);
    else if (p[0] === "configuracion") vista = await vistaConfiguracion();
    else vista = [aviso("ambar", "Esa sección no existe."), enlace("/", "Volver al tablero")];
  } catch {
    vista = [aviso("rojo", "No se pudo cargar esta sección. Revisa tu conexión e inténtalo de nuevo.")];
  }
  cuerpo.replaceChildren(...vista.filter(Boolean));
  cuerpo.removeAttribute("aria-busy");
  cuerpo.querySelector("h1")?.setAttribute("tabindex", "-1");
}

let escuchando = false;
export function desmontarAdmin() {
  if (ctx) limpiarObjetos();
  ctx = null;
  credencialPendiente = null;
}

export async function montarAdmin(yo, raiz) {
  ctx = { yo, empresaId: yo.empresa.id, raiz, objetos: [] };
  await recargarEmpresa();
  if (!escuchando) { window.addEventListener("hashchange", () => ctx && mostrar()); escuchando = true; }
  await mostrar();
}
