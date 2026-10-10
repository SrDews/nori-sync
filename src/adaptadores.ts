/**
 * Las implementaciones REALES de `AdaptadorVault`/`ClienteServidor` (§sync.ts)
 * contra la API de Obsidian. Esta es la única parte del plugin que sabe de
 * `TFile`/`requestUrl`/`crypto.subtle` — el motor de sync no importa nada de
 * acá, así que sigue siendo testeable sin un vault real.
 */
import { requestUrl, type Vault, type FileManager, TFile, TFolder, normalizePath } from "obsidian";
import type { AdaptadorVault, ClienteServidor, RespuestaServidor } from "./sync";

/** Mismo criterio que `vault._oculta()` del lado del servidor: cualquier
 * segmento de ruta que empiece con punto queda afuera del sync — así
 * `.obsidian/` (config de plugins, propia de CADA máquina) nunca viaja, y
 * es lo mismo que ya excluye a `.trash`/`.git`/`.papelera`. */
function ocultaParaSync(ruta: string): boolean {
  return ruta.split("/").some((seg) => seg.startsWith("."));
}

/** SHA-256 truncado a 16 hex — igual algoritmo que `vault._hash_archivo()`
 * del servidor, para que "mismo contenido" dé el mismo valor en los dos
 * lados. `crypto.subtle` es Web Crypto: funciona en desktop (Electron) y en
 * móvil (Capacitor) sin depender del módulo `crypto` de Node, que no existe
 * en el lado móvil. */
async function hashDeBuffer(datos: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", datos);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export class ObsidianVaultAdapter implements AdaptadorVault {
  constructor(private vault: Vault, private fileManager: FileManager) {}

  async listar(): Promise<Map<string, string>> {
    const salida = new Map<string, string>();
    for (const archivo of this.vault.getFiles()) {
      if (ocultaParaSync(archivo.path)) continue;
      const datos = await this.vault.adapter.readBinary(archivo.path);
      salida.set(archivo.path, await hashDeBuffer(datos));
    }
    return salida;
  }

  async leer(ruta: string): Promise<ArrayBuffer> {
    return this.vault.adapter.readBinary(normalizePath(ruta));
  }

  async escribir(ruta: string, datos: ArrayBuffer): Promise<void> {
    const destino = normalizePath(ruta);
    const carpeta = destino.split("/").slice(0, -1).join("/");
    if (carpeta && !(this.vault.getAbstractFileByPath(carpeta) instanceof TFolder)) {
      await this.vault.createFolder(carpeta).catch(() => {});   // ya puede existir
    }
    await this.vault.adapter.writeBinary(destino, datos);
  }

  async borrarAPapelera(ruta: string): Promise<void> {
    const archivo = this.vault.getAbstractFileByPath(normalizePath(ruta));
    if (archivo instanceof TFile) {
      // Respeta la preferencia de borrado de Obsidian (papelera del sistema
      // o `.trash/`). Solo llega acá un archivo que ya se borró en el
      // servidor, y ese borrado dejó su copia en `.papelera/` de allá.
      await this.fileManager.trashFile(archivo);
    }
  }
}

export class HttpClienteServidor implements ClienteServidor {
  constructor(private servidor: string, private token: string) {}

  private url(ruta: string): string {
    return `${this.servidor.replace(/\/+$/, "")}/api/vault/archivo?ruta=${encodeURIComponent(ruta)}`;
  }

  async manifiesto(): Promise<{ modo: "escritura" | "lectura"; archivos: Map<string, string> }> {
    const r = await requestUrl({
      url: `${this.servidor.replace(/\/+$/, "")}/api/vault/manifiesto`,
      headers: { "X-Sync-Token": this.token },
      throw: false,
    });
    if (r.status !== 200) throw new Error(`manifiesto: HTTP ${r.status}`);
    const cuerpo = r.json as { modo: "escritura" | "lectura"; archivos: Record<string, { h: string }> };
    const archivos = new Map<string, string>();
    for (const [ruta, meta] of Object.entries(cuerpo.archivos)) archivos.set(ruta, meta.h);
    return { modo: cuerpo.modo, archivos };
  }

  async bajar(ruta: string): Promise<ArrayBuffer> {
    const r = await requestUrl({ url: this.url(ruta), headers: { "X-Sync-Token": this.token }, throw: false });
    if (r.status !== 200) throw new Error(`bajar ${ruta}: HTTP ${r.status}`);
    return r.arrayBuffer;
  }

  async subir(ruta: string, datos: ArrayBuffer, ifMatch?: string): Promise<RespuestaServidor> {
    const headers: Record<string, string> = { "X-Sync-Token": this.token };
    if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
    const r = await requestUrl({
      url: this.url(ruta), method: "PUT", headers, body: datos, throw: false,
    });
    return { ok: r.status === 200, status: r.status };
  }

  async borrar(ruta: string): Promise<RespuestaServidor> {
    const r = await requestUrl({
      url: this.url(ruta), method: "DELETE", headers: { "X-Sync-Token": this.token }, throw: false,
    });
    return { ok: r.status === 200, status: r.status };
  }
}
