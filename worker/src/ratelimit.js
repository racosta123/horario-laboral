// Límites con Durable Objects. Un objeto por clave ("ip:…", "uid:…", "pin:…", "pinip:…").
// Un DO procesa sus peticiones en serie, así que los contadores son atómicos.
//   contar    → ventana fija: cuenta la petición y dice si se excedió { max, ventanaMs }.
//   fallo     → suma un fallo; al llegar a max se bloquea bloqueoMs { max, ventanaMs, bloqueoMs }.
//   consultar → solo dice si está bloqueado.
//   reiniciar → borra el estado (p. ej. tras un acceso correcto o un PIN nuevo).
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { accion = "contar", max, ventanaMs, bloqueoMs = 0 } = await request.json();
    const now = Date.now();

    if (accion === "reiniciar") {
      await this.state.storage.put("f", null);
      return Response.json({ bloqueado: false });
    }

    if (accion === "contar") {
      let s = (await this.state.storage.get("s")) || { inicio: now, n: 0 };
      if (now - s.inicio >= ventanaMs) s = { inicio: now, n: 0 };
      s.n += 1;
      await this.state.storage.put("s", s);
      const excedido = s.n > max;
      return Response.json({ excedido, reintentarEnMs: excedido ? s.inicio + ventanaMs - now : 0 });
    }

    // Fallos con bloqueo.
    let f = (await this.state.storage.get("f")) || { inicio: 0, n: 0, hasta: 0 };
    if (f.hasta && f.hasta <= now) f = { inicio: 0, n: 0, hasta: 0 };
    if (f.inicio && now - f.inicio > ventanaMs && !f.hasta) f = { inicio: 0, n: 0, hasta: 0 };
    if (accion === "fallo" && !f.hasta) {
      if (!f.inicio) f.inicio = now;
      f.n += 1;
      if (f.n >= max) f.hasta = now + bloqueoMs;
      await this.state.storage.put("f", f);
    }
    const bloqueado = f.hasta > now;
    return Response.json({ bloqueado, reintentarEnMs: bloqueado ? f.hasta - now : 0, fallos: f.n });
  }
}

async function llamar(env, clave, cuerpo) {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(clave));
  const res = await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify(cuerpo) });
  return res.json();
}

// Cuenta una petición para `clave`. Devuelve { excedido, reintentarEnMs }.
export const contar = (env, clave, { max, ventanaMs }) => llamar(env, clave, { accion: "contar", max, ventanaMs });
export const registrarFallo = (env, clave, limite) => llamar(env, clave, { accion: "fallo", ...limite });
export const consultarBloqueo = (env, clave, limite) => llamar(env, clave, { accion: "consultar", ...limite });
export const reiniciarFallos = (env, clave) => llamar(env, clave, { accion: "reiniciar" });
