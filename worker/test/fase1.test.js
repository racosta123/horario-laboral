// Fase 1: sitios, trabajadores, PIN, acceso de empleados, gafetes, foto del alta, marca y conteos de cobro.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { JPEG, PEPPER, PNG, crearMundo } from "./harness.js";
import { mesActual } from "../src/base.js";
import { RE_GAFETE, sha256Hex } from "../src/crypto.js";
import { CONSENTIMIENTO_FOTO } from "../src/handlers/trabajadores.js";

let m;
const SUPER = { uid: "super", claims: { rol: "superadmin" } };
const tok = (u) => m.token(u.uid, u.claims);

async function nuevaEmpresa(nombre) {
  const r = await m.pedir("POST", "/v1/empresas", { token: await tok(SUPER), body: { nombre, admin: { nombre: `Admin ${nombre}`, email: `admin@${nombre.toLowerCase()}.mx` } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const admin = { uid: r.body.adminUid, claims: { rol: "admin_empresa", empresaId: r.body.empresaId } };
  return { id: r.body.empresaId, clave: r.body.clave, admin };
}
const SITIO = { nombre: "Planta Norte", direccion: "Blvd. Kino 100", lat: 29.09, lng: -110.95, radioM: 150 };
const TRAB = (sitios, extra = {}) => ({
  numero: "G-001", nombre: "Juan", apellidos: "Pérez López", fechaNacimiento: "1990-05-10", sucursales: sitios, modo: "ambos",
  consentimientoFoto: { aceptado: true, version: CONSENTIMIENTO_FOTO }, ...extra,
});
const fueraDeEmpresa = (e) => (k) => !k.startsWith(`empresas/${e}`);
// Todo Firestore como texto (para buscar secretos que no deben estar).
const todoFirestore = () => JSON.stringify([...m.docs.entries()]);

let A, B, sitioA, sitioB;
beforeEach(async () => {
  m = await crearMundo();
  m.poner("usuarios/super", { rol: "superadmin", empresaId: "", nombre: "Diagonal", activo: true });
  A = await nuevaEmpresa("Alfa");
  B = await nuevaEmpresa("Beta");
  sitioA = (await m.pedir("POST", "/v1/sitios", { token: await tok(A.admin), body: SITIO })).body.id;
  sitioB = (await m.pedir("POST", "/v1/sitios", { token: await tok(B.admin), body: SITIO })).body.id;
});

async function alta(emp, sitios, extra) {
  const r = await m.pedir("POST", "/v1/trabajadores", { token: await tok(emp.admin), body: TRAB(sitios, extra) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body; // { id, uid, pin }
}
const entrar = (clave, numero, pin, ipFija) => m.pedir("POST", "/v1/empleado/entrar", { body: { clave, numero, pin }, ipFija });

describe("empresa nueva", () => {
  test("nace con clave de acceso, conteos en cero, plan de prueba y marca por defecto", async () => {
    const e = m.leer(`empresas/${A.id}`);
    assert.match(A.clave, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(e.clave, A.clave);
    assert.equal(m.leer(`claves/${A.clave}`).empresaId, A.id);
    assert.equal(e.plan, "prueba");
    assert.equal(e.marca.colorPrimario, "#0F9D94");
    assert.equal(e.config.pinConGafete, false);
  });
});

describe("sitios", () => {
  test("crear: guarda zona, cuenta sitios activos y el máximo del mes", async () => {
    const s = m.leer(`empresas/${A.id}/sucursales/${sitioA}`);
    assert.deepEqual([s.nombre, s.lat, s.lng, s.radioM, s.activo], ["Planta Norte", 29.09, -110.95, 150, true]);
    assert.equal(m.leer(`empresas/${A.id}`).sitiosActivos, 1);
    assert.equal(m.leer(`empresas/${A.id}/consumo/${mesActual()}`).maxSitios, 1);
    assert.ok(m.rutas(`empresas/${A.id}/bitacora/`).length >= 2);
  });
  test("desactivar baja el conteo pero el máximo del mes se conserva; reactivar lo sube", async () => {
    const t = await tok(A.admin);
    assert.equal((await m.pedir("POST", "/v1/sitios/estado", { token: t, body: { id: sitioA, activo: false } })).status, 200);
    assert.equal(m.leer(`empresas/${A.id}`).sitiosActivos, 0);
    assert.equal(m.leer(`empresas/${A.id}/consumo/${mesActual()}`).maxSitios, 1);
    await m.pedir("POST", "/v1/sitios/estado", { token: t, body: { id: sitioA, activo: true } });
    assert.equal(m.leer(`empresas/${A.id}`).sitiosActivos, 1);
    // Repetir el mismo estado no cuenta doble.
    await m.pedir("POST", "/v1/sitios/estado", { token: t, body: { id: sitioA, activo: true } });
    assert.equal(m.leer(`empresas/${A.id}`).sitiosActivos, 1);
  });
  test("validación: radio, coordenadas y nombre", async () => {
    const t = await tok(A.admin);
    for (const malo of [{ radioM: 10 }, { radioM: 5000 }, { lat: 91 }, { lng: -181 }, { nombre: "" }, { lat: "29" }]) {
      assert.equal((await m.pedir("POST", "/v1/sitios", { token: t, body: { ...SITIO, ...malo } })).status, 400, JSON.stringify(malo));
    }
  });
  test("aislamiento: el admin de A no edita ni desactiva sitios de B", async () => {
    const t = await tok(A.admin);
    assert.equal((await m.pedir("POST", "/v1/sitios/editar", { token: t, body: { ...SITIO, id: sitioB, nombre: "Hack" } })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/sitios/estado", { token: t, body: { id: sitioB, activo: false } })).status, 404);
    assert.equal(m.leer(`empresas/${B.id}/sucursales/${sitioB}`).nombre, "Planta Norte");
  });
  test("solo el admin de la empresa: superadmin, supervisor y trabajador reciben 403", async () => {
    m.poner("usuarios/supA", { rol: "supervisor", empresaId: A.id, nombre: "Sup", activo: true });
    m.poner("usuarios/trA", { rol: "trabajador", empresaId: A.id, nombre: "T", activo: true });
    for (const u of [SUPER, { uid: "supA", claims: { rol: "supervisor", empresaId: A.id } }, { uid: "trA", claims: { rol: "trabajador", empresaId: A.id } }]) {
      assert.equal((await m.pedir("POST", "/v1/sitios", { token: await tok(u), body: SITIO })).status, 403, u.uid);
    }
  });
  test("empresa desactivada: su admin ya no puede operar", async () => {
    m.poner(`empresas/${A.id}`, { ...m.leer(`empresas/${A.id}`), activo: false });
    assert.equal((await m.pedir("POST", "/v1/sitios", { token: await tok(A.admin), body: SITIO })).status, 403);
  });
});

describe("alta de trabajadores", () => {
  test("alta: devuelve un PIN de 6 dígitos UNA vez; Firestore solo guarda su hash; nunca el pepper", async () => {
    const t = await alta(A, [sitioA]);
    assert.match(t.pin, /^\d{6}$/);
    const doc = m.leer(`empresas/${A.id}/trabajadores/${t.id}`);
    assert.equal(doc.numero, "G-001");
    assert.equal(doc.uid, `t-${A.id}-${t.id}`);
    assert.equal(doc.consentimientoFoto.version, CONSENTIMIENTO_FOTO);
    assert.equal(doc.gafete.estado, "ninguno");
    const priv = m.leer(`empresas/${A.id}/privado/${t.id}`);
    assert.match(priv.pinHash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(priv.pinIter, 5000);
    const todo = todoFirestore();
    assert.equal(todo.includes(`"${t.pin}"`), false, "el PIN no aparece en Firestore");
    assert.equal(todo.includes(PEPPER), false, "el pepper no aparece en Firestore");
    assert.deepEqual(m.leer(`usuarios/${doc.uid}`), { ...m.leer(`usuarios/${doc.uid}`), rol: "trabajador", empresaId: A.id, trabajadorId: t.id, activo: true });
    assert.equal(m.leer(`empresas/${A.id}/numeros/G-001`).trabajadorId, t.id);
    assert.equal(m.leer(`empresas/${A.id}`).empleadosActivos, 1);
    assert.equal(m.leer(`empresas/${A.id}/consumo/${mesActual()}`).maxEmpleados, 1);
    const bit = m.rutas(`empresas/${A.id}/bitacora/`).map((k) => JSON.stringify(m.leer(k))).join();
    assert.ok(bit.includes("trabajador_alta"));
    assert.equal(bit.includes(t.pin), false, "la bitácora no lleva el PIN");
  });
  test("número de empleado único por empresa (pero se puede repetir en otra empresa)", async () => {
    await alta(A, [sitioA]);
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: await tok(A.admin), body: TRAB([sitioA]) })).status, 409);
    await alta(B, [sitioB]);
  });
  test("sitios: deben existir, ser de la empresa y estar activos", async () => {
    const t = await tok(A.admin);
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([sitioB]) })).status, 400, "sitio de otra empresa");
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB(["0".repeat(20)]) })).status, 400, "sitio inexistente");
    await m.pedir("POST", "/v1/sitios/estado", { token: t, body: { id: sitioA, activo: false } });
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([sitioA]) })).status, 400, "sitio inactivo");
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([]) })).status, 400, "sin sitios");
  });
  test("validación: edad mínima (LFT), fechas imposibles, modo y consentimiento", async () => {
    const t = await tok(A.admin);
    const hoy = new Date();
    const menor15 = `${hoy.getUTCFullYear() - 14}-01-01`;
    for (const malo of [{ fechaNacimiento: menor15 }, { fechaNacimiento: "1990-02-30" }, { fechaNacimiento: "10/05/1990" }, { modo: "fax" },
      { numero: "con espacio" }, { numero: "1234567890123" }, { nombre: "" }, { consentimientoFoto: { aceptado: true, version: "otra" } },
      { consentimientoFoto: { aceptado: false, version: CONSENTIMIENTO_FOTO } }]) {
      assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([sitioA], malo) })).status, 400, JSON.stringify(malo));
    }
    // 15 años sí se permite (validar con el abogado las reglas de menores).
    const t15 = await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([sitioA], { numero: "M15", fechaNacimiento: `${hoy.getUTCFullYear() - 16}-01-01` }) });
    assert.equal(t15.status, 200);
    // Sin consentimiento también se puede dar de alta (pero no se podrá subir foto).
    assert.equal((await m.pedir("POST", "/v1/trabajadores", { token: t, body: TRAB([sitioA], { numero: "SINF", consentimientoFoto: null }) })).status, 200);
  });
  test("tope de trabajadores activos por empresa", async () => {
    m.poner(`empresas/${A.id}`, { ...m.leer(`empresas/${A.id}`), empleadosActivos: 500 });
    const r = await m.pedir("POST", "/v1/trabajadores", { token: await tok(A.admin), body: TRAB([sitioA]) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "tope_alcanzado");
  });
  test("transacción: si otra petición choca, reintenta; si choca siempre, responde conflicto sin escribir nada", async () => {
    m.txAbortar = 1;
    await alta(A, [sitioA]);
    m.txAbortar = 10;
    const r = await m.pedir("POST", "/v1/trabajadores", { token: await tok(A.admin), body: TRAB([sitioA], { numero: "G-002" }) });
    assert.equal(r.status, 409);
    assert.equal(m.leer(`empresas/${A.id}/numeros/G-002`), undefined);
    assert.equal(m.leer(`empresas/${A.id}`).empleadosActivos, 1);
  });
});

describe("edición, baja y reactivación", () => {
  test("editar: cambia datos y sitios; el número no se puede cambiar", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    const base = { id: t.id, nombre: "Juan Carlos", apellidos: "Pérez", fechaNacimiento: "1990-05-10", sucursales: [sitioA], modo: "quiosco" };
    assert.equal((await m.pedir("POST", "/v1/trabajadores/editar", { token: tk, body: base })).status, 200);
    const d = m.leer(`empresas/${A.id}/trabajadores/${t.id}`);
    assert.deepEqual([d.nombre, d.modo, d.numero], ["Juan Carlos", "quiosco", "G-001"]);
    assert.equal(m.leer(`usuarios/${d.uid}`).nombre, "Juan Carlos Pérez");
    assert.equal((await m.pedir("POST", "/v1/trabajadores/editar", { token: tk, body: { ...base, numero: "X-9" } })).status, 400);
  });
  test("aislamiento: el admin de B no edita, da de baja, cambia PIN ni emite gafete a trabajadores de A", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(B.admin);
    const body = { id: t.id, nombre: "Hack", apellidos: "X", fechaNacimiento: "1990-05-10", sucursales: [sitioB], modo: "ambos" };
    assert.equal((await m.pedir("POST", "/v1/trabajadores/editar", { token: tk, body })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: t.id, activo: false } })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/trabajadores/pin", { token: tk, body: { id: t.id } })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/trabajadores/gafete/revocar", { token: tk, body: { id: t.id } })).status, 404);
    assert.equal(m.leer(`empresas/${A.id}/trabajadores/${t.id}`).nombre, "Juan");
  });
  test("baja: desactiva perfil, revoca gafete y sesión, baja el conteo (el máximo del mes se conserva)", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    const g = (await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).body;
    m.cuentas.set(t.uid, { email: null, claims: null }); // ya había entrado alguna vez
    assert.equal((await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: t.id, activo: false } })).status, 200);
    assert.equal(m.leer(`empresas/${A.id}/trabajadores/${t.id}`).activo, false);
    assert.equal(m.leer(`usuarios/${t.uid}`).activo, false);
    assert.equal(m.leer(`gafetes/${await sha256Hex(g.codigo)}`).activo, false);
    assert.equal(m.leer(`empresas/${A.id}/privado/${t.id}`).gafeteHash, null);
    assert.equal(m.cuentas.get(t.uid).deshabilitada, true);
    assert.ok(m.cuentas.get(t.uid).validSince, "sesiones revocadas");
    assert.equal(m.leer(`empresas/${A.id}`).empleadosActivos, 0);
    assert.equal(m.leer(`empresas/${A.id}/consumo/${mesActual()}`).maxEmpleados, 1);
    // Reactivar: vuelve a contar, se habilita la cuenta, el gafete sigue revocado.
    assert.equal((await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: t.id, activo: true } })).status, 200);
    assert.equal(m.leer(`empresas/${A.id}`).empleadosActivos, 1);
    assert.equal(m.cuentas.get(t.uid).deshabilitada, false);
    assert.equal(m.leer(`empresas/${A.id}/trabajadores/${t.id}`).gafete.estado, "revocado");
  });
  test("baja de alguien que nunca entró (sin cuenta en Auth) no falla", async () => {
    const t = await alta(A, [sitioA]);
    assert.equal((await m.pedir("POST", "/v1/trabajadores/estado", { token: await tok(A.admin), body: { id: t.id, activo: false } })).status, 200);
  });
  test("cobro: el máximo del mes refleja el pico de empleados activos", async () => {
    const tk = await tok(A.admin);
    const ids = [];
    for (const n of ["E1", "E2", "E3"]) ids.push((await alta(A, [sitioA], { numero: n })).id);
    await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: ids[0], activo: false } });
    await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: ids[1], activo: false } });
    await alta(A, [sitioA], { numero: "E4" });
    assert.equal(m.leer(`empresas/${A.id}`).empleadosActivos, 2);
    assert.equal(m.leer(`empresas/${A.id}/consumo/${mesActual()}`).maxEmpleados, 3);
  });
});

describe("acceso de empleados (clave + número + PIN)", () => {
  test("correcto: token personalizado firmado por la cuenta de servicio con rol trabajador y su empresa", async () => {
    const t = await alta(A, [sitioA]);
    const r = await entrar(A.clave, "g-001", t.pin);
    assert.equal(r.status, 200);
    const p = await m.verificarTokenPersonalizado(r.body.token);
    assert.ok(p, "firma válida");
    assert.equal(p.uid, t.uid);
    assert.deepEqual(p.claims, { rol: "trabajador", empresaId: A.id });
    assert.ok(p.exp - p.iat <= 300);
  });
  test("con ese rol, /v1/yo devuelve su perfil y su trabajadorId", async () => {
    const t = await alta(A, [sitioA]);
    const r = await m.pedir("GET", "/v1/yo", { token: await m.token(t.uid, { rol: "trabajador", empresaId: A.id }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.trabajadorId, t.id);
  });
  test("errores: mismo mensaje para clave, número, PIN o formato incorrectos", async () => {
    const t = await alta(A, [sitioA]);
    const otroPin = t.pin === "135790" ? "246801" : "135790";
    const resp = [
      await entrar("ZZZZZZ", "G-001", t.pin), await entrar(B.clave, "G-001", t.pin), await entrar(A.clave, "G-999", t.pin),
      await entrar(A.clave, "G-001", otroPin), await entrar(A.clave, "G-001", "12ab"), await entrar("x", "G-001", t.pin),
    ];
    for (const r of resp) assert.equal(r.status, 401);
    assert.equal(new Set(resp.map((r) => r.body.detalle)).size, 1, "un solo mensaje");
  });
  test("bloqueo por empleado: tras 5 fallos ni el PIN correcto entra; otro empleado no se afecta", async () => {
    const t = await alta(A, [sitioA]);
    const t2 = await alta(A, [sitioA], { numero: "G-002" });
    const malo = t.pin === "135790" ? "246801" : "135790";
    for (let i = 0; i < 5; i++) assert.equal((await entrar(A.clave, "G-001", malo)).status, 401);
    assert.equal((await entrar(A.clave, "G-001", t.pin)).status, 401, "bloqueado aunque el PIN sea correcto");
    assert.equal((await entrar(A.clave, "G-002", t2.pin)).status, 200, "otro empleado sigue entrando");
  });
  test("bloqueo por IP: 20 fallos desde una IP la bloquean; otra IP sigue entrando", async () => {
    const t = await alta(A, [sitioA]);
    for (let i = 0; i < 20; i++) await entrar(A.clave, `X-${i}`, "111111", "6.6.6.6");
    assert.equal((await entrar(A.clave, "G-001", t.pin, "6.6.6.6")).status, 401);
    assert.equal((await entrar(A.clave, "G-001", t.pin, "7.7.7.7")).status, 200);
  });
  test("restablecer PIN: el anterior deja de servir, el nuevo entra y se quita el bloqueo", async () => {
    const t = await alta(A, [sitioA]);
    const malo = t.pin === "135790" ? "246801" : "135790";
    for (let i = 0; i < 5; i++) await entrar(A.clave, "G-001", malo);
    const r = await m.pedir("POST", "/v1/trabajadores/pin", { token: await tok(A.admin), body: { id: t.id } });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.pin, t.pin);
    assert.equal(todoFirestore().includes(`"${r.body.pin}"`), false);
    assert.equal((await entrar(A.clave, "G-001", t.pin)).status, 401);
    assert.equal((await entrar(A.clave, "G-001", r.body.pin)).status, 200);
  });
  test("trabajador dado de baja o empresa inactiva: no entra", async () => {
    const t = await alta(A, [sitioA]);
    await m.pedir("POST", "/v1/trabajadores/estado", { token: await tok(A.admin), body: { id: t.id, activo: false } });
    assert.equal((await entrar(A.clave, "G-001", t.pin)).status, 401);
    const t2 = await alta(B, [sitioB]);
    m.poner(`empresas/${B.id}`, { ...m.leer(`empresas/${B.id}`), activo: false });
    assert.equal((await entrar(B.clave, "G-001", t2.pin)).status, 401);
  });
  test("sin el PIN_PEPPER del Worker, el hash de Firestore no coincide (no sirve para adivinar PINs)", async () => {
    const t = await alta(A, [sitioA]);
    m.env.PIN_PEPPER = [...PEPPER].reverse().join(""); // otra pimienta, distinta a la del alta
    assert.equal((await entrar(A.clave, "G-001", t.pin)).status, 401);
  });
});

describe("gafetes", () => {
  test("emitir: código opaco HL1 + 26, solo su hash en Firestore, nunca el código", async () => {
    const t = await alta(A, [sitioA]);
    const r = await m.pedir("POST", "/v1/trabajadores/gafete", { token: await tok(A.admin), body: { id: t.id } });
    assert.equal(r.status, 200);
    assert.match(r.body.codigo, RE_GAFETE);
    assert.equal(r.body.codigo.includes(t.id) || r.body.codigo.includes("G-001"), false, "sin datos del trabajador");
    const h = await sha256Hex(r.body.codigo);
    assert.deepEqual([m.leer(`gafetes/${h}`).activo, m.leer(`gafetes/${h}`).empresaId], [true, A.id]);
    assert.equal(todoFirestore().includes(r.body.codigo), false, "el código no está en Firestore");
    assert.equal(m.leer(`empresas/${A.id}/trabajadores/${t.id}`).gafete.estado, "activo");
  });
  test("reimprimir: el gafete anterior deja de servir al instante", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    const g1 = (await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).body;
    const g2 = (await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).body;
    assert.notEqual(g1.codigo, g2.codigo);
    assert.equal(g2.version, 2);
    assert.equal(m.leer(`gafetes/${await sha256Hex(g1.codigo)}`).activo, false);
    assert.equal(m.leer(`gafetes/${await sha256Hex(g2.codigo)}`).activo, true);
  });
  test("revocar (gafete perdido): queda inactivo; revocar de nuevo avisa que no hay gafete", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    const g = (await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).body;
    assert.equal((await m.pedir("POST", "/v1/trabajadores/gafete/revocar", { token: tk, body: { id: t.id } })).status, 200);
    assert.equal(m.leer(`gafetes/${await sha256Hex(g.codigo)}`).activo, false);
    assert.equal(m.leer(`empresas/${A.id}/trabajadores/${t.id}`).gafete.estado, "revocado");
    assert.equal((await m.pedir("POST", "/v1/trabajadores/gafete/revocar", { token: tk, body: { id: t.id } })).status, 409);
    // Mientras tanto puede entrar con número + PIN.
    assert.equal((await entrar(A.clave, "G-001", t.pin)).status, 200);
  });
  test("no se emite gafete a un trabajador dado de baja", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    await m.pedir("POST", "/v1/trabajadores/estado", { token: tk, body: { id: t.id, activo: false } });
    assert.equal((await m.pedir("POST", "/v1/trabajadores/gafete", { token: tk, body: { id: t.id } })).status, 409);
  });
});

describe("foto del alta (R2 privado)", () => {
  test("sin consentimiento registrado no se acepta la foto", async () => {
    const t = await alta(A, [sitioA], { consentimientoFoto: null });
    const r = await m.pedir("POST", `/v1/trabajadores/foto?id=${t.id}`, { token: await tok(A.admin), bytes: JPEG(), tipo: "image/jpeg" });
    assert.equal(r.status, 409);
    assert.equal(m.objetos.size, 0);
  });
  test("subir y reemplazar: solo JPEG real y de hasta 400 KB; la anterior se borra", async () => {
    const t = await alta(A, [sitioA]);
    const tk = await tok(A.admin);
    const ruta = `/v1/trabajadores/foto?id=${t.id}`;
    assert.equal((await m.pedir("POST", ruta, { token: tk, bytes: PNG(), tipo: "image/png" })).status, 415);
    assert.equal((await m.pedir("POST", ruta, { token: tk, bytes: new Uint8Array(2000).fill(65), tipo: "image/jpeg" })).status, 400, "no es JPEG aunque lo diga");
    assert.equal((await m.pedir("POST", ruta, { token: tk, bytes: JPEG(401 * 1024), tipo: "image/jpeg" })).status, 413);
    assert.equal((await m.pedir("POST", ruta, { token: tk, bytes: JPEG(3000), tipo: "image/jpeg" })).status, 200);
    const f1 = m.leer(`empresas/${A.id}/trabajadores/${t.id}`).foto.id;
    assert.ok(m.objetos.has(`empresas/${A.id}/fotos/${t.id}/${f1}.jpg`));
    assert.equal((await m.pedir("POST", ruta, { token: tk, bytes: JPEG(4000), tipo: "image/jpeg" })).status, 200);
    assert.equal(m.objetos.has(`empresas/${A.id}/fotos/${t.id}/${f1}.jpg`), false, "la foto anterior se borró");
    assert.equal(m.objetos.size, 1);
  });
  test("quién la ve: admin de su empresa y el propio trabajador; nadie más", async () => {
    const t = await alta(A, [sitioA]);
    const t2 = await alta(A, [sitioA], { numero: "G-002" });
    await m.pedir("POST", `/v1/trabajadores/foto?id=${t.id}`, { token: await tok(A.admin), bytes: JPEG(3000), tipo: "image/jpeg" });
    const ver = async (token) => m.pedir("GET", `/v1/trabajadores/foto?id=${t.id}`, { token });
    const r = await ver(await tok(A.admin));
    assert.equal(r.status, 200);
    assert.equal(r.bytes.length, 3000);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await ver(await m.token(t.uid, { rol: "trabajador", empresaId: A.id }))).status, 200, "el propio trabajador");
    assert.equal((await ver(await m.token(t2.uid, { rol: "trabajador", empresaId: A.id }))).status, 403, "otro trabajador");
    m.poner("usuarios/supA", { rol: "supervisor", empresaId: A.id, nombre: "Sup", activo: true });
    assert.equal((await ver(await m.token("supA", { rol: "supervisor", empresaId: A.id }))).status, 403, "supervisor");
    assert.equal((await ver(await tok(SUPER))).status, 403, "superadmin");
    assert.equal((await ver(await tok(B.admin))).status, 404, "admin de otra empresa");
    assert.equal((await ver()).status, 401, "sin sesión");
    assert.equal((await ver(await m.token("x"))).status, 403, "sin claims");
  });
  test("identificadores manipulados: rechazo antes de tocar datos", async () => {
    const tk = await tok(A.admin);
    for (const idMalo of ["../x", `${B.id}/trabajadores/x`, "abc", "", "0".repeat(21)]) {
      assert.equal((await m.pedir("GET", `/v1/trabajadores/foto?id=${encodeURIComponent(idMalo)}`, { token: tk })).status, 400, idMalo);
    }
  });
});

describe("marca y configuración de la empresa", () => {
  test("colores, PIN con gafete y logo (PNG/JPEG reales, hasta 200 KB)", async () => {
    const tk = await tok(A.admin);
    assert.equal((await m.pedir("POST", "/v1/empresa/marca", { token: tk, body: { colorPrimario: "#123abc", colorSecundario: "#000000" } })).status, 200);
    assert.equal(m.leer(`empresas/${A.id}`).marca.colorPrimario, "#123ABC");
    for (const malo of [{ colorPrimario: "red" }, { colorPrimario: "#12345" }, { colorPrimario: "#1234567" }]) {
      assert.equal((await m.pedir("POST", "/v1/empresa/marca", { token: tk, body: { colorPrimario: "#000000", colorSecundario: "#000000", ...malo } })).status, 400);
    }
    assert.equal((await m.pedir("POST", "/v1/empresa/config", { token: tk, body: { pinConGafete: true } })).status, 200);
    assert.equal(m.leer(`empresas/${A.id}`).config.pinConGafete, true);
    assert.equal((await m.pedir("POST", "/v1/empresa/config", { token: tk, body: { pinConGafete: "si" } })).status, 400);
    assert.equal((await m.pedir("POST", "/v1/empresa/logo", { token: tk, bytes: PNG(1000), tipo: "image/png" })).status, 200);
    assert.equal((await m.pedir("POST", "/v1/empresa/logo", { token: tk, bytes: PNG(201 * 1024), tipo: "image/png" })).status, 413);
    assert.equal((await m.pedir("POST", "/v1/empresa/logo", { token: tk, bytes: new TextEncoder().encode("<svg onload=alert(1)>"), tipo: "image/svg+xml" })).status, 415);
  });
  test("el logo lo ve cualquier miembro de SU empresa; otra empresa no", async () => {
    await m.pedir("POST", "/v1/empresa/logo", { token: await tok(A.admin), bytes: PNG(1000), tipo: "image/png" });
    const t = await alta(A, [sitioA]);
    const r = await m.pedir("GET", "/v1/empresa/logo", { token: await m.token(t.uid, { rol: "trabajador", empresaId: A.id }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal((await m.pedir("GET", "/v1/empresa/logo", { token: await tok(B.admin) })).status, 404);
    assert.equal((await m.pedir("GET", "/v1/empresa/logo", { token: await tok(SUPER) })).status, 403);
  });
  test("solo el admin cambia la marca", async () => {
    const t = await alta(A, [sitioA]);
    const r = await m.pedir("POST", "/v1/empresa/marca", { token: await m.token(t.uid, { rol: "trabajador", empresaId: A.id }), body: { colorPrimario: "#000000", colorSecundario: "#000000" } });
    assert.equal(r.status, 403);
  });
});

describe("rutas solo del Worker: nada sensible fuera de su lugar", () => {
  test("PIN y gafete viven en empresas/{e}/privado y gafetes/ (las reglas los niegan a todos los clientes)", async () => {
    const t = await alta(A, [sitioA]);
    await m.pedir("POST", "/v1/trabajadores/gafete", { token: await tok(A.admin), body: { id: t.id } });
    const doc = JSON.stringify(m.leer(`empresas/${A.id}/trabajadores/${t.id}`));
    assert.equal(/pinHash|pinSal|gafeteHash/.test(doc), false, "el documento del trabajador (legible por el admin) no lleva secretos");
    assert.ok(m.rutas("gafetes/").length === 1);
    assert.ok(m.rutas(`empresas/${A.id}/privado/`).length === 1);
    assert.equal(m.rutas().filter(fueraDeEmpresa(A.id)).some((k) => k.includes(t.id) && !k.startsWith("gafetes/") && !k.startsWith("usuarios/")), false);
  });
});
