import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { b64u, crearMundo, ORIGIN, SETUP } from "./harness.js";

let m;
beforeEach(async () => {
  m = await crearMundo();
  m.poner("usuarios/super", { rol: "superadmin", empresaId: "", nombre: "Diagonal", activo: true });
  m.poner("usuarios/adminA", { rol: "admin_empresa", empresaId: "A", nombre: "Ana", activo: true });
  m.poner("usuarios/trabA", { rol: "trabajador", empresaId: "A", nombre: "Juan", activo: true });
  m.poner("usuarios/bajaA", { rol: "trabajador", empresaId: "A", nombre: "Ex", activo: false });
  m.poner("empresas/A", { nombre: "Empresa A", activo: true });
});

const EMPRESA = { nombre: "Tortillería La Esperanza", rfc: "TES010203AB1", admin: { nombre: "Rubén", email: "ruben@ejemplo.mx" } };

describe("/salud", () => {
  test("responde sin datos sensibles y con cabeceras de seguridad", async () => {
    const r = await m.pedir("GET", "/salud");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(m.llamadas.length, 0, "no toca Google");
  });
  test("ruta desconocida: 404", async () => {
    assert.equal((await m.pedir("GET", "/nada")).status, 404);
    assert.equal((await m.pedir("POST", "/salud", { body: {} })).status, 404);
  });
});

describe("CORS", () => {
  test("origen permitido recibe allow-origin exacto", async () => {
    const r = await m.pedir("OPTIONS", "/v1/yo");
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  });
  test("otro origen: 403 y sin cabeceras CORS", async () => {
    for (const o of ["https://evil.example", "https://racosta123.github.io.evil.example", "http://racosta123.github.io", "null"]) {
      const r = await m.pedir("GET", "/salud", { origin: o });
      assert.equal(r.status, 403, o);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
    }
  });
  test("localhost solo si DEV_ORIGINS lo incluye (wrangler dev)", async () => {
    assert.equal((await m.pedir("GET", "/salud", { origin: "http://localhost:5173" })).status, 403);
    m.env.DEV_ORIGINS = "http://localhost:5173";
    const r = await m.pedir("GET", "/salud", { origin: "http://localhost:5173" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });
});

describe("verificación del ID token", () => {
  test("sin token o mal formado: 401", async () => {
    assert.equal((await m.pedir("GET", "/v1/yo")).status, 401);
    assert.equal((await m.pedir("GET", "/v1/yo", { token: "abc" })).status, 401);
    assert.equal((await m.pedir("GET", "/v1/yo", { token: "a.b.c" })).status, 401);
  });
  test("firmado por otra llave: 401", async () => {
    const t = await m.token("super", { rol: "superadmin" }, { llave: m.llaveIntruso });
    assert.equal((await m.pedir("GET", "/v1/yo", { token: t })).status, 401);
  });
  test("kid desconocido, otro proyecto, expirado o del futuro: 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const over of [{ kid: "otra" }, { aud: "otro-proyecto" }, { iss: "https://securetoken.google.com/otro" }, { exp: now - 1 }, { iat: now + 3600 }]) {
      const t = await m.token("super", { rol: "superadmin" }, over);
      assert.equal((await m.pedir("GET", "/v1/yo", { token: t })).status, 401, JSON.stringify(over));
    }
  });
  test("alg none / payload alterado: 401", async () => {
    const t = await m.token("trabA", { rol: "trabajador", empresaId: "A" });
    const [h, , s] = t.split(".");
    const p = b64u(new TextEncoder().encode(JSON.stringify({ sub: "trabA", rol: "superadmin", aud: "hl-test" })));
    assert.equal((await m.pedir("GET", "/v1/yo", { token: `${h}.${p}.${s}` })).status, 401);
    const none = b64u(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k1" })));
    assert.equal((await m.pedir("GET", "/v1/yo", { token: `${none}.${p}.` })).status, 401);
  });
  test("token válido SIN claims (auto-registro): 403", async () => {
    const t = await m.token("cualquiera");
    const r = await m.pedir("GET", "/v1/yo", { token: t });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "sin_acceso");
  });
  test("perfil dado de baja o incongruente con el claim: 403", async () => {
    assert.equal((await m.pedir("GET", "/v1/yo", { token: await m.token("bajaA", { rol: "trabajador", empresaId: "A" }) })).status, 403);
    assert.equal((await m.pedir("GET", "/v1/yo", { token: await m.token("trabA", { rol: "trabajador", empresaId: "B" }) })).status, 403);
    assert.equal((await m.pedir("GET", "/v1/yo", { token: await m.token("trabA", { rol: "admin_empresa", empresaId: "A" }) })).status, 403);
  });
  test("token válido con rol: devuelve su perfil", async () => {
    const r = await m.pedir("GET", "/v1/yo", { token: await m.token("trabA", { rol: "trabajador", empresaId: "A" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { uid: "trabA", rol: "trabajador", nombre: "Juan", empresa: { id: "A", nombre: "Empresa A" } });
  });
});

describe("alta de empresa (solo superadmin)", () => {
  test("superadmin crea empresa + admin_empresa con claims, perfil y bitácora", async () => {
    const t = await m.token("super", { rol: "superadmin" });
    const r = await m.pedir("POST", "/v1/empresas", { token: t, body: EMPRESA });
    assert.equal(r.status, 200);
    const { empresaId, adminUid } = r.body;
    assert.match(empresaId, /^[a-f0-9]{20}$/);
    assert.deepEqual(m.cuentas.get(adminUid).claims, { rol: "admin_empresa", empresaId });
    assert.equal(m.leer(`empresas/${empresaId}`).nombre, EMPRESA.nombre);
    assert.deepEqual({ ...m.leer(`usuarios/${adminUid}`), creado: undefined }, { rol: "admin_empresa", empresaId, nombre: "Rubén", activo: true, creado: undefined });
    assert.deepEqual(m.correos, ["ruben@ejemplo.mx"]);
    assert.ok([...m.docs.keys()].some((k) => k.includes(`empresas/${empresaId}/bitacora/`)));
    assert.equal(JSON.stringify(r.body).includes(m.cuentas.get(adminUid).password), false, "la contraseña nunca se devuelve");
  });
  for (const [quien, claims] of [["adminA", { rol: "admin_empresa", empresaId: "A" }], ["trabA", { rol: "trabajador", empresaId: "A" }]]) {
    test(`${quien} no puede: 403 y no crea nada`, async () => {
      const r = await m.pedir("POST", "/v1/empresas", { token: await m.token(quien, claims), body: EMPRESA });
      assert.equal(r.status, 403);
      assert.equal(m.cuentas.size, 0);
    });
  }
  test("sin claims tampoco (aunque diga ser superadmin en el body)", async () => {
    const r = await m.pedir("POST", "/v1/empresas", { token: await m.token("x"), body: { ...EMPRESA, rol: "superadmin" } });
    assert.equal(r.status, 403);
  });
  test("datos inválidos: 400; content-type distinto: 415; cuerpo enorme: 413", async () => {
    const t = await m.token("super", { rol: "superadmin" });
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: { ...EMPRESA, admin: { nombre: "R", email: "no-es-correo" } } })).status, 400);
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: { ...EMPRESA, rfc: "XXX" } })).status, 400);
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: { ...EMPRESA, nombre: "" } })).status, 400);
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: { ...EMPRESA, nombre: "x".repeat(9000) } })).status, 413);
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal(m.cuentas.size, 0);
  });
  test("correo ya registrado: 409", async () => {
    const t = await m.token("super", { rol: "superadmin" });
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: EMPRESA })).status, 200);
    assert.equal((await m.pedir("POST", "/v1/empresas", { token: t, body: EMPRESA })).status, 409);
  });
  test("si Firestore falla, la cuenta creada se borra (no quedan huérfanas)", async () => {
    m.fallarCommit = true;
    const r = await m.pedir("POST", "/v1/empresas", { token: await m.token("super", { rol: "superadmin" }), body: EMPRESA });
    assert.equal(r.status, 502);
    assert.equal(m.cuentas.size, 0);
  });
});

describe("alta única del superadmin", () => {
  const body = { nombre: "Diagonal Catorce", email: "admin@ejemplo.mx" };
  beforeEach(() => m.docs.clear());
  test("token incorrecto o ausente: 404 (no revela que existe)", async () => {
    assert.equal((await m.pedir("POST", "/v1/setup/superadmin", { body })).status, 404);
    assert.equal((await m.pedir("POST", "/v1/setup/superadmin", { token: "x".repeat(40), body })).status, 404);
  });
  test("sin SETUP_TOKEN configurado: deshabilitado", async () => {
    delete m.env.SETUP_TOKEN;
    assert.equal((await m.pedir("POST", "/v1/setup/superadmin", { token: "", body })).status, 404);
  });
  test("funciona una sola vez", async () => {
    const r = await m.pedir("POST", "/v1/setup/superadmin", { token: SETUP, body });
    assert.equal(r.status, 200);
    assert.deepEqual(m.cuentas.get(r.body.uid).claims, { rol: "superadmin" });
    const r2 = await m.pedir("POST", "/v1/setup/superadmin", { token: SETUP, body: { ...body, email: "otro@ejemplo.mx" } });
    assert.equal(r2.status, 409);
    assert.equal(m.cuentas.size, 1);
  });
  test("fuerza bruta: 429 después de 5 intentos por IP", async () => {
    const codigos = [];
    for (let i = 0; i < 7; i++) codigos.push((await m.pedir("POST", "/v1/setup/superadmin", { token: "y".repeat(40), body, ipFija: "1.2.3.4" })).status);
    assert.deepEqual(codigos, [404, 404, 404, 404, 404, 429, 429]);
  });
});

describe("límite de peticiones", () => {
  test("por IP: 429 con retry-after al pasar de 120/min", async () => {
    let ultimo;
    for (let i = 0; i < 121; i++) ultimo = await m.pedir("GET", "/salud", { ipFija: "9.9.9.9" });
    assert.equal(ultimo.status, 429);
    assert.ok(Number(ultimo.headers.get("retry-after")) > 0);
    assert.equal((await m.pedir("GET", "/salud", { ipFija: "9.9.9.8" })).status, 200, "otra IP no se afecta");
  });
  test("por usuario: 429 al pasar de 60/min aunque cambie de IP", async () => {
    const t = await m.token("trabA", { rol: "trabajador", empresaId: "A" });
    const codigos = [];
    for (let i = 0; i < 61; i++) codigos.push((await m.pedir("GET", "/v1/yo", { token: t })).status);
    assert.equal(codigos[59], 200);
    assert.equal(codigos[60], 429);
  });
});
