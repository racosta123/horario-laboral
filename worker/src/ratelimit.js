// Límite de peticiones con ventana fija. Un Durable Object por clave ("ip:…", "uid:…", "setup:…").
// Un DO procesa sus peticiones en serie, así que el contador es atómico.
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { max, ventanaMs } = await request.json();
    const now = Date.now();
    let s = (await this.state.storage.get("s")) || { inicio: now, n: 0 };
    if (now - s.inicio >= ventanaMs) s = { inicio: now, n: 0 };
    s.n += 1;
    await this.state.storage.put("s", s);
    const excedido = s.n > max;
    return Response.json({ excedido, reintentarEnMs: excedido ? s.inicio + ventanaMs - now : 0 });
  }
}

// Cuenta una petición para `clave`. Devuelve { excedido, reintentarEnMs }.
export async function contar(env, clave, { max, ventanaMs }) {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(clave));
  const res = await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ max, ventanaMs }) });
  return res.json();
}
