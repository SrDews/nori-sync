/**
 * Vaults Nori del lado de Obsidian (PLAN_VAULTS_NORI V.3, V.4, V.7): la API, el selector con tarjetas, el aviso
 * antes de mezclar y el acomodo de las fotos en `FOTOS/` con verificación de enlaces. Las reglas puras están en
 * `vaults.ts`; este archivo es el que sabe de `App`, `Modal` y `requestUrl`.
 */
import { App, Modal, TFile, TFolder, normalizePath, requestUrl, setIcon } from "obsidian";
import { enlaceEsDeFoto, megas, oculta, planFotos, reubicarEnlaces, type VaultNori } from "./vaults";

// ---------- API ----------

export interface ResumenVaults {
  vaults: VaultNori[];
  sueltos: number;
  uso: { bytes: number; cuota: number };
}

export async function listarVaultsNori(servidor: string, token: string): Promise<ResumenVaults> {
  const r = await requestUrl({
    url: `${servidor.replace(/\/+$/, "")}/api/vaults-nori`, headers: { "X-Sync-Token": token }, throw: false,
  });
  if (r.status !== 200) throw new Error((r.json as { error?: string } | null)?.error || `HTTP ${r.status}`);
  return r.json as ResumenVaults;
}

/** Crea el Vault Nori. Si el nombre ya existe (409) es un error: usarlo en silencio juntaría este Obsidian con un
 * vault con notas sin el aviso de mezcla. */
export async function crearVaultNori(servidor: string, token: string, nombre: string): Promise<string> {
  const r = await requestUrl({
    url: `${servidor.replace(/\/+$/, "")}/api/vaults-nori`, method: "POST",
    headers: { "X-Sync-Token": token }, contentType: "application/json",
    body: JSON.stringify({ nombre }), throw: false,
  });
  const cuerpo = r.json as { nombre?: string; error?: string } | null;
  if (r.status === 201) return cuerpo?.nombre || nombre;
  if (r.status === 409) throw new Error(`ya existe un Vault Nori «${nombre.trim()}»: elegilo de la lista o usá otro nombre`);
  throw new Error(cuerpo?.error || `HTTP ${r.status}`);
}

export function notasLocales(app: App): number {
  return app.vault.getFiles().filter((f) => !oculta(f.path) && (f.extension === "md" || f.extension === "canvas")).length;
}

export function archivosLocales(app: App): number {
  return app.vault.getFiles().filter((f) => !oculta(f.path)).length;
}

function haceCuanto(iso: string | null): string {
  if (!iso) return "";
  const seg = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(seg) || seg < 0) return "";
  if (seg < 90) return "editado recién";
  if (seg < 3600) return `editado hace ${Math.floor(seg / 60)} min`;
  if (seg < 86400) return `editado hace ${Math.floor(seg / 3600)} h`;
  const dias = Math.floor(seg / 86400);
  return `editado hace ${dias} ${dias === 1 ? "día" : "días"}`;
}

// ---------- Modales chicos ----------

export function pedirTexto(app: App, titulo: string, placeholder: string, inicial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let resuelto = false;
    const modal = new Modal(app);
    modal.titleEl.setText(titulo);
    const input = modal.contentEl.createEl("input", { type: "text", placeholder, value: inicial, cls: "nori-input" });
    const botones = modal.contentEl.createDiv({ cls: "modal-button-container" });
    const responder = (valor: string | null) => { resuelto = true; resolve(valor); modal.close(); };
    botones.createEl("button", { text: "Aceptar", cls: "mod-cta" })
      .addEventListener("click", () => responder(input.value.trim() || null));
    botones.createEl("button", { text: "Cancelar" }).addEventListener("click", () => responder(null));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") responder(input.value.trim() || null); });
    modal.onClose = () => { if (!resuelto) resolve(null); };
    modal.open();
    input.focus();
  });
}

/** Una pregunta con varias salidas; `null` = cerrado sin elegir. */
export function elegirOpcion<T extends string>(app: App, titulo: string, texto: string,
  opciones: Array<{ valor: T; texto: string; cta?: boolean }>): Promise<T | null> {
  return new Promise((resolve) => {
    let resuelto = false;
    const modal = new Modal(app);
    modal.titleEl.setText(titulo);
    modal.contentEl.createEl("p", { text: texto });
    const botones = modal.contentEl.createDiv({ cls: "modal-button-container" });
    for (const o of opciones) {
      botones.createEl("button", { text: o.texto, cls: o.cta ? "mod-cta" : "" })
        .addEventListener("click", () => { resuelto = true; resolve(o.valor); modal.close(); });
    }
    modal.onClose = () => { if (!resuelto) resolve(null); };
    modal.open();
  });
}

// ---------- Selector de Vault Nori (V.3) ----------

export type Eleccion = { tipo: "vault"; vault: VaultNori } | { tipo: "nuevo" } | { tipo: "todo" };

export class ModalVaultsNori extends Modal {
  private resuelto = false;

  constructor(app: App, private datos: ResumenVaults, private actual: string | null,
    private aviso: string | null, private resolver: (e: Eleccion | null) => void) {
    super(app);
  }

  static elegir(app: App, datos: ResumenVaults, actual: string | null, aviso: string | null): Promise<Eleccion | null> {
    return new Promise((resolve) => new ModalVaultsNori(app, datos, actual, aviso, resolve).open());
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("nori-modal-vaults");
    this.titleEl.setText("Elegí tu Vault Nori");
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Este Obsidian va a tener solo el contenido del Vault Nori que elijas. Los demás quedan guardados en Nori.",
    });
    if (this.aviso) contentEl.createEl("p", { cls: "mod-warning", text: this.aviso });
    const { uso } = this.datos;
    contentEl.createEl("p", { cls: "nori-uso", text: `Usás ${megas(uso.bytes)} de ${megas(uso.cuota)}.` });

    const grilla = contentEl.createDiv({ cls: "nori-vaults" });
    for (const v of this.datos.vaults.filter((x) => !x.archivado)) this.tarjeta(grilla, v);
    const nuevo = grilla.createDiv({ cls: "nori-vault-card nori-vault-card--nuevo" });
    setIcon(nuevo.createDiv({ cls: "nori-vault-icono" }), "plus");
    nuevo.createDiv({ cls: "nori-vault-nombre", text: "Vault Nori nuevo" });
    nuevo.createDiv({ cls: "nori-vault-datos", text: "Para un corte o un semestre nuevo" });
    nuevo.addEventListener("click", () => this.terminar({ tipo: "nuevo" }));

    const archivados = this.datos.vaults.filter((x) => x.archivado);
    if (archivados.length) {
      const det = contentEl.createEl("details", { cls: "nori-archivados" });
      det.createEl("summary", { text: `Archivados (${archivados.length})` });
      const g = det.createDiv({ cls: "nori-vaults" });
      for (const v of archivados) this.tarjeta(g, v);
    }
    const todo = contentEl.createEl("button", { cls: "nori-link", text: "Avanzado: sincronizar todo mi Nori (todas las carpetas)" });
    todo.addEventListener("click", () => this.terminar({ tipo: "todo" }));
  }

  private tarjeta(padre: HTMLElement, v: VaultNori) {
    const card = padre.createDiv({ cls: "nori-vault-card" + (v.nombre === this.actual ? " is-actual" : "") });
    setIcon(card.createDiv({ cls: "nori-vault-icono" }), "vault");
    card.createDiv({ cls: "nori-vault-nombre", text: v.nombre });
    const partes = [`${v.notas} notas`, `${v.fotos} fotos`, megas(v.bytes), haceCuanto(v.actualizado)].filter(Boolean);
    card.createDiv({ cls: "nori-vault-datos", text: partes.join(" · ") });
    if (v.nombre === this.actual) card.createDiv({ cls: "nori-vault-marca", text: "Vinculado" });
    card.addEventListener("click", () => this.terminar({ tipo: "vault", vault: v }));
  }

  private terminar(e: Eleccion) {
    this.resuelto = true;
    this.resolver(e);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resuelto) this.resolver(null);
  }
}

// ---------- FOTOS/ (V.4) ----------

export interface ResultadoFotos {
  movidas: Array<{ de: string; a: string }>;
  revertidas: string[];
  sinLugar: string[];
  enlaces: number;
}

/** Enlaces rotos de notas y tableros, como claves `origen→destino`. */
function enlacesRotos(app: App, canvasTextos: Map<string, string>): Set<string> {
  const rotos = new Set<string>();
  for (const [origen, destinos] of Object.entries(app.metadataCache.unresolvedLinks)) {
    for (const destino of Object.keys(destinos)) rotos.add(`${origen}→${destino}`);
  }
  for (const [ruta, texto] of canvasTextos) {
    let nodos: Array<{ type?: string; file?: unknown }> = [];
    try { nodos = (JSON.parse(texto) as { nodes?: typeof nodos }).nodes ?? []; } catch { continue; }
    for (const n of nodos) {
      if (n.type !== "file" || typeof n.file !== "string") continue;
      const existe = app.vault.getAbstractFileByPath(n.file) || app.metadataCache.getFirstLinkpathDest(n.file, ruta);
      if (!existe) rotos.add(`${ruta}→${n.file}`);
    }
  }
  return rotos;
}

async function leerCanvas(app: App): Promise<Map<string, string>> {
  const salida = new Map<string, string>();
  for (const f of app.vault.getFiles()) {
    if (f.extension === "canvas" && !oculta(f.path)) salida.set(f.path, await app.vault.read(f));
  }
  return salida;
}

function esperarMetadata(app: App): Promise<void> {
  return new Promise((resolve) => {
    const ref = app.metadataCache.on("resolved", () => { app.metadataCache.offref(ref); resolve(); });
    window.setTimeout(() => { app.metadataCache.offref(ref); resolve(); }, 4000);
  });
}

async function reescribirTextos(app: App, mapa: Map<string, string>, aplicar: boolean): Promise<number> {
  let total = 0;
  for (const f of app.vault.getFiles()) {
    if (oculta(f.path) || (f.extension !== "md" && f.extension !== "canvas")) continue;
    const texto = await app.vault.read(f);
    const r = reubicarEnlaces(texto, f.extension === "md" ? "md" : "canvas", mapa);
    if (!r.cambios) continue;
    total += r.cambios;
    if (aplicar) await app.vault.modify(f, r.texto);
  }
  return total;
}

/** Lo que haría `acomodarFotos`, sin tocar nada: para la confirmación. */
export async function previsualizarFotos(app: App, todo: boolean, excluir: Set<string>, contarEnlaces: boolean):
  Promise<{ fotos: number; enlaces: number; sinLugar: string[] }> {
  const { mapa, sinLugar } = planFotos(app.vault.getFiles().map((f) => f.path), todo, excluir);
  if (!contarEnlaces) return { fotos: mapa.size, enlaces: 0, sinLugar };
  return { fotos: mapa.size, enlaces: mapa.size ? await reescribirTextos(app, mapa, false) : 0, sinLugar };
}

async function asegurarCarpeta(app: App, ruta: string) {
  const carpeta = ruta.split("/").slice(0, -1).join("/");
  if (carpeta && !(app.vault.getAbstractFileByPath(carpeta) instanceof TFolder)) {
    await app.vault.createFolder(carpeta).catch(() => {});      // ya puede existir
  }
}

/**
 * Mueve cada foto fuera de lugar a su `FOTOS/` y arregla los enlaces: `fileManager.renameFile` (según la preferencia
 * de la persona) y además una pasada propia que no depende de esa preferencia. Después compara los enlaces rotos
 * de antes y de después: una foto que deja un enlace roto nuevo vuelve a su lugar. Nada se borra.
 */
export async function acomodarFotos(app: App, todo: boolean, excluir: Set<string>): Promise<ResultadoFotos> {
  const { mapa, sinLugar } = planFotos(app.vault.getFiles().map((f) => f.path), todo, excluir);
  const resultado: ResultadoFotos = { movidas: [], revertidas: [], sinLugar, enlaces: 0 };
  if (!mapa.size) return resultado;

  const antes = enlacesRotos(app, await leerCanvas(app));
  const hechas = new Map<string, string>();
  for (const [de, a] of mapa) {
    const archivo = app.vault.getAbstractFileByPath(normalizePath(de));
    if (!(archivo instanceof TFile)) continue;
    await asegurarCarpeta(app, a);
    try {
      await app.fileManager.renameFile(archivo, normalizePath(a));
      hechas.set(de, a);
    } catch (e) {
      console.error(`Nori: no se pudo mover ${de}`, e);
    }
  }
  resultado.enlaces = await reescribirTextos(app, hechas, true);
  await esperarMetadata(app);

  const nuevos = [...enlacesRotos(app, await leerCanvas(app))].filter((k) => !antes.has(k));
  if (nuevos.length) {
    const deshacer = new Map<string, string>();
    for (const [de, a] of hechas) {
      if (nuevos.some((k) => enlaceEsDeFoto(k.slice(k.indexOf("→") + 1), de, a))) deshacer.set(a, de);
    }
    for (const [a, de] of deshacer) {
      const archivo = app.vault.getAbstractFileByPath(a);
      if (archivo instanceof TFile) {
        await asegurarCarpeta(app, de);
        await app.fileManager.renameFile(archivo, de);
      }
      hechas.delete(de);
      resultado.revertidas.push(de);
    }
    if (deshacer.size) await reescribirTextos(app, deshacer, true);
  }
  resultado.movidas = [...hechas].map(([de, a]) => ({ de, a }));
  return resultado;
}
