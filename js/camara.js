// Captura de fotos con la cámara del teléfono (o archivo) y compresión local antes de subir.
// Se usa <input type="file" capture>: funciona igual en Android e iPhone y no requiere permisos extra.
// La imagen se reduce en el navegador (lado mayor ≤ 600 px, JPEG) para que pese poco en redes lentas.

export function elegirImagen({ camara = "user", tipos = "image/jpeg,image/png" } = {}) {
  return new Promise((resolver) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = tipos;
    if (camara) input.setAttribute("capture", camara);
    input.addEventListener("change", () => resolver(input.files?.[0] || null), { once: true });
    input.click();
  });
}

async function cargar(archivo) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(archivo, { imageOrientation: "from-image" }); } catch { /* respaldo abajo */ }
  }
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error("imagen_invalida")); };
    img.src = url;
  });
}

// Devuelve un Blob JPEG del tamaño indicado. tipo "png" conserva transparencia (logos).
export async function comprimir(archivo, { ladoMax = 600, tipo = "image/jpeg", calidad = 0.82, maxBytes = 380 * 1024 } = {}) {
  const img = await cargar(archivo);
  const w = img.width, h = img.height;
  const escala = Math.min(1, ladoMax / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * escala);
  canvas.height = Math.round(h * escala);
  const ctx = canvas.getContext("2d");
  if (tipo === "image/jpeg") { ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  for (let q = calidad; q >= 0.4; q -= 0.12) {
    const blob = await new Promise((ok) => canvas.toBlob(ok, tipo, q));
    if (blob && blob.size <= maxBytes) return blob;
    if (tipo === "image/png") break;
  }
  throw new Error("imagen_muy_grande");
}
