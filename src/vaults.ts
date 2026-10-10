/**
 * Vaults Nori (PLAN_VAULTS_NORI): reglas puras, sin imports de 'obsidian', para poder probarlas con Node solo.
 *
 * - Un «Vault Nori» es una carpeta de primer nivel del vault de la cuenta en el servidor. Este Obsidian se vincula
 *   a uno (`carpetaRemota`) y recibe solo su contenido; con `carpetaRemota = ""` sincroniza todo, como antes.
 * - Las fotos van siempre en `FOTOS/` de su Vault Nori. Visto desde Obsidian: `FOTOS/…` si está vinculado a un
 *   Vault Nori, o `<carpeta>/FOTOS/…` si sincroniza todo (la misma regla que aplica el servidor).
 */

export const FOTOS = "FOTOS";
export const EXT_FOTOS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".bmp", ".svg"];

export function extension(ruta: string): string {
  const nombre = ruta.slice(ruta.lastIndexOf("/") + 1);
  const punto = nombre.lastIndexOf(".");
  return punto <= 0 ? "" : nombre.slice(punto).toLowerCase();
}

export function esFoto(ruta: string): boolean {
  return EXT_FOTOS.includes(extension(ruta));
}

export function oculta(ruta: string): boolean {
  return ruta.split("/").some((seg) => seg.startsWith("."));
}

/** ¿Esta foto (ruta local) ya está donde tiene que estar? `todo` = sincroniza el vault entero. */
export function fotoBienUbicada(ruta: string, todo: boolean): boolean {
  const partes = ruta.split("/");
  return todo ? partes.length >= 3 && partes[1] === FOTOS : partes.length >= 2 && partes[0] === FOTOS;
}

/** La carpeta `FOTOS` que le toca a una foto, o null si no hay dónde (en modo `todo`, una foto en la raíz). */
export function carpetaFotosDe(ruta: string, todo: boolean): string | null {
  if (!todo) return FOTOS;
  const partes = ruta.split("/");
  return partes.length >= 2 ? `${partes[0]}/${FOTOS}` : null;
}

/** `carpeta/nombre`, o `carpeta/base (2).ext`… si ya está ocupado. */
export function rutaLibre(carpeta: string, nombre: string, ocupadas: Set<string>): string {
  const punto = nombre.lastIndexOf(".");
  const base = punto > 0 ? nombre.slice(0, punto) : nombre;
  const ext = punto > 0 ? nombre.slice(punto) : "";
  let candidata = `${carpeta}/${nombre}`;
  for (let n = 2; ocupadas.has(candidata); n++) candidata = `${carpeta}/${base} (${n})${ext}`;
  return candidata;
}

/** `{viejo → nuevo}` para cada foto mal ubicada. `existentes` = todas las rutas del vault local. */
export function planFotos(existentes: string[], todo: boolean, excluir: Set<string> = new Set()):
  { mapa: Map<string, string>; sinLugar: string[] } {
  const ocupadas = new Set(existentes);
  const mapa = new Map<string, string>();
  const sinLugar: string[] = [];
  for (const ruta of [...existentes].sort()) {
    if (oculta(ruta) || !esFoto(ruta) || fotoBienUbicada(ruta, todo) || excluir.has(ruta)) continue;
    const carpeta = carpetaFotosDe(ruta, todo);
    if (!carpeta) { sinLugar.push(ruta); continue; }
    const destino = rutaLibre(carpeta, ruta.slice(ruta.lastIndexOf("/") + 1), ocupadas);
    ocupadas.add(destino);
    mapa.set(ruta, destino);
  }
  return { mapa, sinLugar };
}

function sinExtension(ruta: string): string {
  const punto = ruta.lastIndexOf(".");
  return punto > ruta.lastIndexOf("/") ? ruta.slice(0, punto) : ruta;
}

function nombreDe(ruta: string): string {
  return ruta.slice(ruta.lastIndexOf("/") + 1);
}

/**
 * Reescribe los enlaces a archivos movidos. Solo toca lo que nombra la ruta VIEJA completa (con o sin extensión,
 * en `[[…]]`, `![[…]]` o `![…](…)`) y, en los `.canvas`, también el `file` que nombra la foto por su nombre suelto
 * (así resuelven los tableros reales de Dew) cuando ese nombre es de un solo archivo movido: queda la ruta completa.
 * Un `[[nombre]]` suelto en una nota no se toca: Obsidian lo sigue resolviendo por nombre.
 */
export function reubicarEnlaces(texto: string, tipo: "md" | "canvas", mapa: Map<string, string>): { texto: string; cambios: number } {
  if (!mapa.size) return { texto, cambios: 0 };
  if (tipo === "canvas") return reubicarCanvas(texto, mapa);
  let cambios = 0;
  const conRuta = new Map<string, string>();
  for (const [viejo, nuevo] of mapa) {
    conRuta.set(viejo, nuevo);
    conRuta.set(sinExtension(viejo), sinExtension(nuevo));
  }
  let salida = texto.replace(/(!?\[\[)([^\]|#\n]+)([^\]\n]*\]\])/g, (todo, abre: string, destino: string, resto: string) => {
    const nuevo = conRuta.get(destino.trim());
    if (nuevo === undefined || !destino.includes("/")) return todo;
    cambios++;
    return `${abre}${nuevo}${resto}`;
  });
  salida = salida.replace(/(!?\[[^\]\n]*\]\()(<?)([^)\n>]+)(>?\))/g, (todo, abre: string, a: string, destino: string, cierra: string) => {
    let crudo = destino;
    try { crudo = decodeURI(destino); } catch { /* queda tal cual */ }
    const nuevo = mapa.get(crudo);
    if (nuevo === undefined) return todo;
    cambios++;
    return `${abre}${a}${destino.includes("%20") ? encodeURI(nuevo) : nuevo}${cierra}`;
  });
  return { texto: salida, cambios };
}

function reubicarCanvas(texto: string, mapa: Map<string, string>): { texto: string; cambios: number } {
  let canvas: { nodes?: Array<Record<string, unknown>> };
  try {
    canvas = JSON.parse(texto) as typeof canvas;
  } catch {
    return { texto, cambios: 0 };                       // un JSON roto no se toca
  }
  const porNombre = new Map<string, string | null>();
  for (const [viejo, nuevo] of mapa) {
    const n = nombreDe(viejo);
    porNombre.set(n, porNombre.has(n) ? null : nuevo);   // null = nombre ambiguo, no se adivina
  }
  let cambios = 0;
  for (const nodo of canvas.nodes ?? []) {
    if (nodo.type !== "file" || typeof nodo.file !== "string") continue;
    const nuevo = mapa.get(nodo.file) ?? (!nodo.file.includes("/") ? porNombre.get(nodo.file) : undefined);
    if (nuevo) {
      nodo.file = nuevo;
      cambios++;
    }
  }
  return cambios ? { texto: JSON.stringify(canvas, null, "\t"), cambios } : { texto, cambios: 0 };
}

/**
 * Cambiar el Vault Nori de este Obsidian (V.3). Lo que ya hay acá se sube al vault nuevo, así que: sin archivos
 * locales, directo; pasar de «todo» a un Vault Nori (o al revés) con archivos, bloqueado (se anidaría todo un nivel
 * o quedarían archivos sueltos en la raíz); entre dos Vaults Nori con archivos, preguntar.
 */
export function decidirCambioVault(actual: string, nuevo: string, archivosLocales: number): "directo" | "preguntar" | "bloquear" {
  if (nuevo === actual || archivosLocales === 0) return "directo";
  if (actual === "" || nuevo === "") return "bloquear";
  return "preguntar";
}

/** ¿Este enlace roto nuevo apunta a la foto que se movió (`de` → `a`)? Por ruta exacta o por su nombre exacto. */
export function enlaceEsDeFoto(destino: string, de: string, a: string): boolean {
  const nombre = a.slice(a.lastIndexOf("/") + 1);
  const sinExt = nombre.replace(/\.[^.]+$/, "");
  const final = destino.slice(destino.lastIndexOf("/") + 1);
  return destino === de || destino === a || final === nombre || final === sinExt;
}

/** Caché de hashes del sync liviano (V.2): solo se relee un archivo si cambió su fecha o su tamaño. */
export interface EntradaCache { m: number; s: number; h: string }

export function hashEnCache(cache: Record<string, EntradaCache>, ruta: string, m: number, s: number): string | null {
  const e = cache[ruta];
  return e && e.m === m && e.s === s ? e.h : null;
}

export interface VaultNori {
  nombre: string;
  notas: number;
  fotos: number;
  bytes: number;
  actualizado: string | null;
  archivado: boolean;
}

export function megas(bytes: number): string {
  const mb = (bytes || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
