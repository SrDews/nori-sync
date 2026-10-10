import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, Platform, requestUrl, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import { Sincronizador, resumirPlan, conPrefijo, requiereConfirmacion, UMBRAL_BORRADO_MASIVO, type ClienteServidor, type ResumenPlan } from "./sync";
import { ObsidianVaultAdapter, HttpClienteServidor } from "./adaptadores";
import { decidirCambioVault, megas, type EntradaCache } from "./vaults";
import {
  acomodarFotos, archivosLocales, crearVaultNori, elegirOpcion, listarVaultsNori, ModalVaultsNori, notasLocales, pedirTexto,
  previsualizarFotos, type ResumenVaults,
} from "./vaultsUi";

interface MedSyncSettings {
  servidor: string;
  token: string | null;
  usuario: string | null;
  modo: "escritura" | "lectura" | null;
  /** Horas entre auto-syncs; 0 = solo manual. */
  intervaloHoras: number;
  ultimoSync: string | null;
  /** Lo que este dispositivo vio la última vez que sincronizó — ruta → hash16.
   * Vacío = "nunca sincronizó", y por eso el motor de sync jamás borra nada
   * en esa corrida (§sync.ts): es el freno de seguridad del primer sync. */
  snapshot: Record<string, string>;
  /** Subcarpeta del vault del servidor a tratar como raíz local (`""` = todo
   * el vault). Sirve para alinear este dispositivo con quien ya sincronizaba
   * por WebDAV apuntando a una subcarpeta puntual. Sin heurística: es texto
   * que la persona tipea una vez. */
  carpetaRemota: string;
  /** V.2: ruta → {mtime, size, hash} del vault local, para no releer lo que no cambió. */
  cacheHashes: Record<string, EntradaCache>;
  /** V.4: fotos ya movidas acá que falta mover igual en el servidor (`POST /api/vault/mover`). */
  movimientosPendientes: Array<{ de: string; a: string }>;
  /** V.4: la persona ya aceptó una vez que Nori Sync acomode las fotos en FOTOS/. */
  fotosAcordado: boolean;
  /** V.3: la cuenta que tuvo este Obsidian antes de desvincularlo (para avisar antes de mezclar cuentas). */
  ultimoUsuario: string | null;
  /** V.4: fotos que volvieron a su lugar porque moverlas rompía un enlace: no se reintentan en cada sync. */
  fotosQuedan: string[];
}

const AJUSTES_DEFECTO: MedSyncSettings = {
  servidor: "https://nori.study",
  token: null,
  usuario: null,
  modo: null,
  intervaloHoras: 12,
  ultimoSync: null,
  snapshot: {},
  carpetaRemota: "",
  cacheHashes: {},
  movimientosPendientes: [],
  fotosAcordado: false,
  ultimoUsuario: null,
  fotosQuedan: [],
};

export default class MedSyncPlugin extends Plugin {
  settings: MedSyncSettings = AJUSTES_DEFECTO;
  private itemStatusBar!: HTMLElement;
  private timerAutoSync: number | null = null;
  private sincronizando = false;
  private avisoFotosMostrado = false;
  private ultimoUso: { bytes: number; cuota: number } | null = null;

  async onload() {
    await this.cargarAjustes();
    this.addSettingTab(new MedSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Nori: sincronizar ahora", () => this.syncAhora(true));
    this.addCommand({
      id: "sync-ahora",
      name: "Sincronizar ahora",
      callback: () => this.syncAhora(true),
    });

    this.itemStatusBar = this.addStatusBarItem();
    this.actualizarStatusBar();

    this.configurarAutoSync();
    // Si Obsidian estuvo cerrado más de un intervalo, el `setInterval` nunca
    // llega a dispararse solo — sin este chequeo al arrancar, un vault que
    // no se abre todos los días simplemente deja de sincronizar en silencio.
    this.revisarSyncVencidoAlArrancar();
  }

  onunload() {
    if (this.timerAutoSync !== null) window.clearInterval(this.timerAutoSync);
  }

  async cargarAjustes() {
    const guardado = (await this.loadData()) as Partial<MedSyncSettings> | null;
    this.settings = Object.assign({}, AJUSTES_DEFECTO, guardado);
  }

  async guardarAjustes() {
    await this.saveData(this.settings);
  }

  vinculado(): boolean {
    return !!this.settings.token;
  }

  actualizarStatusBar() {
    if (!this.vinculado()) {
      this.itemStatusBar.setText("Nori: sin vincular");
      return;
    }
    const ultimo = this.settings.ultimoSync
      ? new Date(this.settings.ultimoSync).toLocaleString()
      : "nunca";
    this.itemStatusBar.setText(`Nori: ${ultimo}`);
  }

  configurarAutoSync() {
    if (this.timerAutoSync !== null) {
      window.clearInterval(this.timerAutoSync);
      this.timerAutoSync = null;
    }
    if (!this.vinculado() || this.settings.intervaloHoras <= 0) return;
    this.timerAutoSync = window.setInterval(
      () => { void this.syncAhora(false); },
      this.settings.intervaloHoras * 3600 * 1000,
    );
    this.registerInterval(this.timerAutoSync);
  }

  private revisarSyncVencidoAlArrancar() {
    if (!this.vinculado() || this.settings.intervaloHoras <= 0) return;
    const vencido = !this.settings.ultimoSync
      || Date.now() - new Date(this.settings.ultimoSync).getTime() >= this.settings.intervaloHoras * 3600 * 1000;
    if (vencido) {
      // Pequeña demora para no competir con el resto de los plugins al abrir.
      window.setTimeout(() => { void this.syncAhora(false); }, 5000);
    }
  }

  async vincular(codigo: string, nombreDispositivo: string): Promise<void> {
    const r = await requestUrl({
      url: `${this.settings.servidor.replace(/\/+$/, "")}/api/obsidian/vincular`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        codigo,
        dispositivo: nombreDispositivo || (Platform.isMobile ? "Celular" : "PC"),
        plataforma: Platform.isMobile ? "movil" : "escritorio",
        nombre_vault: this.app.vault.getName(),
      }),
      throw: false,
    });
    if (r.status !== 200) {
      const cuerpo = r.json as { error?: string } | null;
      const error = cuerpo?.error || `HTTP ${r.status}`;
      throw new Error(error);
    }
    const datos = r.json as { token: string; usuario: string; modo: "escritura" | "lectura" };
    const otraCuenta = !!this.settings.ultimoUsuario && this.settings.ultimoUsuario !== datos.usuario
      && notasLocales(this.app) > 0;
    this.settings.token = datos.token;
    this.settings.usuario = datos.usuario;
    this.settings.modo = datos.modo;
    await this.guardarAjustes();
    this.configurarAutoSync();
    this.actualizarStatusBar();
    await this.elegirVault(otraCuenta, otraCuenta
      ? `Este Obsidian estuvo vinculado a la cuenta de ${this.settings.ultimoUsuario}. Si juntás sus notas con un `
        + `Vault Nori de ${datos.usuario}, se suben a esta cuenta: mejor creá un Vault Nori nuevo o usá otro vault de Obsidian.`
      : null);
  }

  /** V.3: elegir (o crear) el Vault Nori de este Obsidian. Cambiarlo empieza el sync de cero (sin borrar nada). */
  async elegirVault(otraCuenta = false, aviso: string | null = null): Promise<void> {
    if (!this.settings.token) return;
    let datos: ResumenVaults;
    try {
      datos = await listarVaultsNori(this.settings.servidor, this.settings.token);
    } catch (e) {
      new Notice(`Nori: no se pudieron traer tus Vaults Nori — ${e}`);
      return;
    }
    const eleccion = await ModalVaultsNori.elegir(this.app, datos, this.settings.carpetaRemota || null, aviso);
    if (!eleccion) return;
    let nombre: string | null = null;
    try {
      if (eleccion.tipo === "todo") {
        nombre = "";
      } else if (eleccion.tipo === "nuevo") {
        nombre = await this.crearVault();
      } else {
        nombre = eleccion.vault.nombre;
      }
      nombre = nombre === null ? null : await this.confirmarCambio(nombre, eleccion.tipo === "vault" ? eleccion.vault.notas : 0, otraCuenta);
    } catch (e) {
      new Notice(`Nori: ${e}`);
      return;
    }
    if (nombre === null) return;
    if (nombre !== this.settings.carpetaRemota) {
      this.settings.carpetaRemota = nombre;
      this.settings.snapshot = {};               // otra raíz: nada de lo visto antes es comparable
      this.settings.movimientosPendientes = [];
      this.settings.fotosQuedan = [];
      await this.guardarAjustes();
    }
    new Notice(nombre ? `Nori: este Obsidian quedó con el Vault Nori «${nombre}». Sincronizá para traer su contenido.`
      : "Nori: este Obsidian sincroniza todo tu Nori.");
  }

  /** Lo que ya hay en este Obsidian se sube al Vault Nori nuevo: avisar o bloquear antes (ver `decidirCambioVault`). */
  private async confirmarCambio(nombre: string, notasRemotas: number, otraCuenta: boolean): Promise<string | null> {
    const actual = this.settings.carpetaRemota;
    let decision = decidirCambioVault(actual, nombre, archivosLocales(this.app));
    // Lo de otra cuenta se sube a esta aunque el nombre del Vault Nori sea el mismo: siempre se pregunta.
    if (otraCuenta && decision === "directo" && archivosLocales(this.app) > 0) decision = "preguntar";
    if (decision === "directo") return nombre;
    if (decision === "bloquear") {
      await elegirOpcion(this.app, "Usá otro vault de Obsidian",
        actual === ""
          ? "Este Obsidian tiene todo tu Nori, con sus carpetas. Si lo pasás a un solo Vault Nori, todo eso se subiría "
            + `adentro de «${nombre}», un nivel más abajo. Abrí un vault de Obsidian vacío y vinculalo a «${nombre}».`
          : "Este Obsidian tiene el contenido de un Vault Nori. Para sincronizar todo tu Nori, abrí un vault de "
            + "Obsidian vacío y vinculalo ahí.",
        [{ valor: "ok", texto: "Entendido", cta: true }]);
      return null;
    }
    const que = await elegirOpcion(this.app, "Este Obsidian ya tiene archivos",
      `Todo lo que hay acá${actual ? ` (el contenido de «${actual}»)` : ""} se va a subir a «${nombre}»`
      + (notasRemotas ? `, y las ${notasRemotas} notas de «${nombre}» van a bajar acá` : "")
      + ". No se borra nada. Para separar cortes o semestres, lo mejor es un vault de Obsidian por cada Vault Nori.",
      [{ valor: "cancelar", texto: "Cancelar", cta: true }, { valor: "juntar", texto: "Juntar igual" }]);
    return que === "juntar" ? nombre : null;
  }

  private async crearVault(): Promise<string | null> {
    const nombre = await pedirTexto(this.app, "Vault Nori nuevo", "Ej.: Semestre 4 · 1° corte");
    if (!nombre) return null;
    return crearVaultNori(this.settings.servidor, this.settings.token!, nombre);
  }

  /** Solo olvida la vinculación LOCAL — revocar el dispositivo del lado del
   * servidor se hace desde el panel web (Configuración → Conexiones), que es
   * el lugar donde ya vive la lista completa de dispositivos de la persona. */
  async desvincular(): Promise<void> {
    this.settings.ultimoUsuario = this.settings.usuario || this.settings.ultimoUsuario;
    this.settings.movimientosPendientes = [];
    this.settings.token = null;
    this.settings.usuario = null;
    this.settings.modo = null;
    this.settings.ultimoSync = null;
    this.settings.snapshot = {};   // una vinculación nueva empieza de cero, nunca hereda supuestos
    await this.guardarAjustes();
    this.configurarAutoSync();
    this.actualizarStatusBar();
  }

  /**
   * `interactivo=true`: lo disparó una persona (ribbon/comando) — puede
   * mostrar el modal de confirmación del primer sync y un Notice al final.
   * `interactivo=false`: lo disparó el reloj — si haría falta confirmar un
   * primer sync, se salta esta corrida y solo avisa que hay algo pendiente.
   */
  async syncAhora(interactivo: boolean): Promise<void> {
    if (!this.settings.token) {
      if (interactivo) new Notice("Nori: vinculá el plugin primero desde Configuración.");
      return;
    }
    if (this.sincronizando) {
      if (interactivo) new Notice("Nori: ya hay un sync en curso.");
      return;
    }
    this.sincronizando = true;
    try {
      await this.correrSync(interactivo);
    } finally {
      this.sincronizando = false;
    }
  }

  private async correrSync(interactivo: boolean): Promise<void> {
    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault, this.app.fileManager, this.settings.cacheHashes);
    const cliente = conPrefijo(
      new HttpClienteServidor(this.settings.servidor, this.settings.token!),
      this.settings.carpetaRemota,
    );
    if (!await this.prepararSync(interactivo, cliente)) return;
    const snapshot = new Map(Object.entries(this.settings.snapshot));
    const sinc = new Sincronizador(vaultAdapter, cliente, snapshot, async (s) => {
      this.settings.snapshot = Object.fromEntries(s);
      await this.guardarAjustes();
    });

    const esPrimerSync = snapshot.size === 0;
    let plan;
    try {
      ({ plan } = await sinc.planificarAhora());
    } catch (e) {
      new Notice(`Nori: no se pudo conectar — ${e}`);
      return;
    }
    const resumen = resumirPlan(plan);
    if (requiereConfirmacion(resumen, esPrimerSync)) {
      if (!interactivo) {
        new Notice("Nori: sync pendiente de confirmar — abrí Configuración → Nori Sync.");
        return;
      }
      const confirmado = await pedirConfirmacion(this.app, resumen, esPrimerSync);
      if (!confirmado) return;
    }

    if (interactivo) new Notice("Nori: sincronizando…");
    try {
      const soloLectura = this.settings.modo === "lectura";
      const r = await sinc.correr(soloLectura);
      this.settings.ultimoSync = new Date().toISOString();
      await this.guardarAjustes();
      this.actualizarStatusBar();

      const partes: string[] = [];
      if (r.subidos) partes.push(`${r.subidos} subido(s)`);
      if (r.bajados) partes.push(`${r.bajados} bajado(s)`);
      const borrados = r.borradosLocal + r.borradosRemoto;
      if (borrados) partes.push(`${borrados} borrado(s)`);
      if (r.conflictos) partes.push(`${r.conflictos} conflicto(s) — se guardaron las dos versiones`);
      new Notice(partes.length ? `Nori: ${partes.join(", ")}.` : "Nori: todo al día.");
      if (r.errores.length) {
        console.error("Nori — errores durante el sync:", r.errores);
        if (r.errores.some((e) => e.includes("HTTP 507"))) {
          new Notice("Nori: llegaste al máximo de espacio de tu cuenta. Archivá o borrá algo en Nori para seguir subiendo.", 15000);
        }
        if (r.errores.some((e) => e.includes("HTTP 422"))) {
          new Notice("Nori: hay fotos fuera de una carpeta FOTOS que el servidor no acepta (mirá la consola).", 15000);
        }
        new Notice(`Nori: ${r.errores.length} archivo(s) fallaron — mirá la consola.`);
      }
      this.avisarCuota();
    } catch (e) {
      new Notice(`Nori: error — ${e}`);
    }
  }

  /**
   * Antes de planificar (PLAN_VAULTS_NORI): el Vault Nori elegido tiene que seguir existiendo (si se renombró en
   * Nori, sincronizar contra la ruta vieja vería todo «borrado» en el servidor); las fotos se acomodan en FOTOS/
   * (V.4) y lo que ya se movió acá se mueve igual en el servidor, sin borrar ni volver a subir. `false` = no sincronizar.
   */
  private async prepararSync(interactivo: boolean, cliente: ClienteServidor): Promise<boolean> {
    const nombre = this.settings.carpetaRemota;
    try {
      const datos = await listarVaultsNori(this.settings.servidor, this.settings.token!);
      this.ultimoUso = datos.uso;
      if (nombre && !datos.vaults.some((v) => v.nombre === nombre)) {
        new Notice(`Nori: el Vault Nori «${nombre}» ya no existe en Nori (¿lo renombraste?). `
          + "Elegí uno en Configuración → Nori Sync; no se sincronizó nada.", 15000);
        return false;
      }
    } catch (e) {
      new Notice(`Nori: no se pudo conectar — ${e}`);
      return false;
    }
    if (this.settings.modo === "lectura") return true;

    const todo = !nombre;
    const quedan = new Set(this.settings.fotosQuedan);
    // Sin el «sí» de la persona, el sync automático no se frena: sigue sin mover fotos (las que estén fuera de
    // FOTOS/ el servidor no las acepta hasta entonces) y avisa una sola vez.
    const previa = await previsualizarFotos(this.app, todo, quedan, interactivo);
    if (previa.fotos && !this.settings.fotosAcordado && !interactivo) {
      if (!this.avisoFotosMostrado) {
        new Notice("Nori: hay fotos para acomodar en FOTOS/ — sincronizá a mano una vez para confirmarlo.", 10000);
        this.avisoFotosMostrado = true;
      }
    } else if (previa.fotos) {
      if (!this.settings.fotosAcordado) {
        const ok = await confirmar(this.app,
          `Nori Sync guarda las fotos en la carpeta FOTOS${todo ? " de cada Vault Nori" : ""}. Se van a mover `
          + `${previa.fotos} foto(s) a FOTOS/ y actualizar ${previa.enlaces} enlace(s) en tus notas y tableros. `
          + "Nada se borra, y si algún enlace se rompiera, esa foto vuelve a su lugar.");
        if (!ok) return false;
        this.settings.fotosAcordado = true;
      }
      const r = await acomodarFotos(this.app, todo, quedan);
      this.settings.movimientosPendientes.push(...r.movidas);
      this.settings.fotosQuedan = [...new Set([...this.settings.fotosQuedan, ...r.revertidas])];
      await this.guardarAjustes();
      if (r.movidas.length) new Notice(`Nori: ${r.movidas.length} foto(s) movidas a FOTOS/, ${r.enlaces} enlace(s) al día.`);
      if (r.revertidas.length) {
        console.warn("Nori — fotos que volvieron a su lugar (rompían enlaces):", r.revertidas);
        new Notice(`Nori: ${r.revertidas.length} foto(s) no se movieron porque rompían un enlace (mirá la consola).`, 15000);
      }
    }
    if (previa.sinLugar.length) {
      console.warn("Nori — fotos sueltas en la raíz, sin Vault Nori:", previa.sinLugar);
    }
    await this.moverPendientesEnServidor(cliente);
    return true;
  }

  /** Lo movido acá se mueve igual en el servidor: el snapshot queda al día y el sync no ve borrados ni subidas. */
  private async moverPendientesEnServidor(cliente: ClienteServidor): Promise<void> {
    const pendientes = this.settings.movimientosPendientes;
    if (!pendientes.length || !cliente.mover) return;
    const remoto = (await cliente.manifiesto()).archivos;
    const quedan: Array<{ de: string; a: string }> = [];
    for (const m of pendientes) {
      // La precondición es lo que ESTE dispositivo vio (el snapshot), no lo que hay hoy en el servidor: si allá la
      // foto cambió desde el último sync, no se mueve y el sync normal lo trata como un cambio más (sin pisar nada).
      const h = this.settings.snapshot[m.de];
      if (h === undefined || remoto.get(m.de) !== h || remoto.has(m.a)) continue;
      try {
        const r = await cliente.mover(m.de, m.a, h);
        if (r.ok) {
          delete this.settings.snapshot[m.de];
          this.settings.snapshot[m.a] = h;
        } else if (r.status >= 500 || r.status === 0) {
          quedan.push(m);
        }
      } catch {
        quedan.push(m);                                             // sin red: se reintenta en el próximo sync
      }
    }
    this.settings.movimientosPendientes = quedan;
    await this.guardarAjustes();
  }

  /** V.7: aviso al pasar el 80 % de la cuota de la cuenta. */
  private avisarCuota(): void {
    const uso = this.ultimoUso;        // el de `prepararSync`: no hace falta otro pedido por sync
    if (uso && uso.cuota && uso.bytes / uso.cuota >= 0.8) {
      new Notice(`Nori: usás ${megas(uso.bytes)} de ${megas(uso.cuota)}. Archivá o borrá lo que no uses en Nori.`, 12000);
    }
  }
}

/** Reemplazo de `confirm()` (Obsidian pide no usarlo): Aceptar / Cancelar. */
function confirmar(app: App, texto: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resuelto = false;
    const modal = new Modal(app);
    modal.contentEl.createEl("p", { text: texto });
    const botones = modal.contentEl.createDiv({ cls: "modal-button-container" });
    const responder = (ok: boolean) => { resuelto = true; resolve(ok); modal.close(); };
    botones.createEl("button", { text: "Aplicar", cls: "mod-cta" }).addEventListener("click", () => responder(true));
    botones.createEl("button", { text: "Cancelar" }).addEventListener("click", () => responder(false));
    modal.onClose = () => { if (!resuelto) resolve(false); };
    modal.open();
  });
}

function pedirConfirmacion(app: App, resumen: ResumenPlan, esPrimerSync: boolean): Promise<boolean> {
  return new Promise((resolve) => new ModalConfirmarSync(app, resumen, esPrimerSync, resolve).open());
}

class ModalConfirmarSync extends Modal {
  private resuelto = false;

  constructor(
    app: App,
    private resumen: ResumenPlan,
    private esPrimerSync: boolean,
    private resolver: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const borrados = this.resumen.borrarLocal + this.resumen.borrarRemoto;
    contentEl.createEl("h2", {
      text: this.esPrimerSync ? "Primer sync de este vault" : "Este sync va a borrar varios archivos",
    });
    const partes: string[] = [];
    if (this.resumen.subir) partes.push(`subir ${this.resumen.subir}`);
    if (this.resumen.bajar) partes.push(`bajar ${this.resumen.bajar}`);
    if (this.resumen.borrarLocal) partes.push(`borrar ${this.resumen.borrarLocal} local(es)`);
    if (this.resumen.borrarRemoto) partes.push(`borrar ${this.resumen.borrarRemoto} del servidor`);
    contentEl.createEl("p", { text: `Se va a${partes.length ? "n " + partes.join(", ") : "…"}.` });
    if (!this.esPrimerSync && borrados >= UMBRAL_BORRADO_MASIVO) {
      contentEl.createEl("p", {
        text: `Es más borrado de lo habitual (umbral: ${UMBRAL_BORRADO_MASIVO}) para no ser el primer `
          + `sync. Si vos no borraste ni moviste todo esto a propósito, cancelá y revisá antes de seguir.`,
        cls: "mod-warning",
      });
    }
    if (this.resumen.conflicto) {
      contentEl.createEl("p", {
        text: `${this.resumen.conflicto} archivo(s) existen distintos en los dos lados: se guardan `
          + `las DOS versiones, nada se pierde ni se sobrescribe en silencio.`,
      });
    }
    contentEl.createEl("p", {
      text: "Los borrados van a la papelera (la que tengas configurada en Obsidian, y la del servidor), "
        + "pero sincronizar de acá en más ya no vuelve a preguntar salvo que borre mucho de nuevo.",
      cls: "setting-item-description",
    });
    const botones = contentEl.createDiv({ cls: "modal-button-container" });
    const btnOk = botones.createEl("button", { text: "Sincronizar", cls: "mod-cta" });
    btnOk.addEventListener("click", () => { this.resuelto = true; this.resolver(true); this.close(); });
    const btnCancelar = botones.createEl("button", { text: "Cancelar" });
    btnCancelar.addEventListener("click", () => { this.resuelto = true; this.resolver(false); this.close(); });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resuelto) this.resolver(false);   // cerrado con Esc / click afuera = cancelar
  }
}

/** Una fila de la configuración: `name` sirve para la búsqueda de Obsidian
 * 1.13+, `armar` dibuja la fila en las dos APIs (declarativa e imperativa). */
interface Fila {
  name: string;
  armar: (s: Setting) => void;
}

class MedSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MedSyncPlugin) {
    super(app, plugin);
  }

  /** Obsidian 1.13+: la pestaña sale de acá y aparece en la búsqueda de ajustes. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.filas().map((f) => ({ name: f.name, render: (s: Setting) => f.armar(s) }));
  }

  /** Obsidian anterior a 1.13 (desde la 1.13 no se llama: manda getSettingDefinitions). */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const f of this.filas()) f.armar(new Setting(containerEl));
  }

  /** Redibuja tras vincular o desvincular, con la API que tenga esta versión. */
  private refrescar(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.display();
  }

  private filas(): Fila[] {
    return this.plugin.vinculado() ? this.filasVinculado() : this.filasSinVincular();
  }

  private filasVinculado(): Fila[] {
    const ajustes = this.plugin.settings;
    return [
      {
        name: "Cuenta",
        armar: (s) => {
          s.setName("Cuenta").setDesc(`Vinculado como ${ajustes.usuario}.`);
        },
      },
      {
        name: "Modo",
        armar: (s) => {
          s.setName("Modo")
          .setDesc(ajustes.modo === "lectura"
            ? "Solo lectura: bajás los apuntes del grupo, tus ediciones no suben."
            : "Lectura y escritura.")
          .setDisabled(true);
        },
      },
      {
        name: "Vault Nori",
        armar: (s) => {
          s.setName("Vault Nori")
          .setDesc(ajustes.carpetaRemota
            ? `Este Obsidian tiene el contenido de «${ajustes.carpetaRemota}».`
            : "Este Obsidian sincroniza todo tu Nori (todas las carpetas).")
          .addButton((b) => b.setButtonText("Cambiar").setCta().onClick(() => {
            void this.plugin.elegirVault().then(() => this.refrescar());
          }));
        },
      },
      {
        name: "Espacio usado",
        armar: (s) => {
          s.setName("Espacio usado").setDesc("Consultando…");
          listarVaultsNori(ajustes.servidor, ajustes.token!)
            .then(({ uso }) => {
              const alto = uso.cuota > 0 && uso.bytes / uso.cuota >= 0.8;
              s.setDesc(`Usás ${megas(uso.bytes)} de ${megas(uso.cuota)}${alto ? " — casi lleno: archivá o borrá lo que no uses en Nori." : "."}`);
            })
            .catch(() => s.setDesc("No se pudo consultar."));
        },
      },
      {
        name: "Sincronización automática",
        armar: (s) => {
          s.setName("Sincronización automática")
          .setDesc("Cada cuántas horas sincroniza solo. \"Manual\" = solo con el botón o el comando.")
          .addDropdown((d) => {
            d.addOption("0", "Manual");
            for (const horas of [1, 3, 6, 12, 24]) d.addOption(String(horas), `Cada ${horas} h`);
            d.setValue(String(ajustes.intervaloHoras));
            d.onChange(async (valor) => {
              ajustes.intervaloHoras = Number(valor);
              await this.plugin.guardarAjustes();
              this.plugin.configurarAutoSync();
            });
          });
        },
      },
      {
        name: "Sincronizar ahora",
        armar: (s) => {
          s.setName("Sincronizar ahora")
          .setDesc(ajustes.ultimoSync
            ? `Último sync: ${new Date(ajustes.ultimoSync).toLocaleString()}`
            : "Todavía no sincronizó.")
          .addButton((b) => b.setButtonText("Sincronizar").setCta().onClick(() => { void this.plugin.syncAhora(true); }));
        },
      },
      {
        name: "Desvincular",
        armar: (s) => {
          s.setName("Desvincular")
          .setDesc("Olvida este dispositivo. Para cortarle el acceso de verdad, revocalo desde el panel "
            + "web → Configuración → Conexiones.")
          .addButton((b) => b.setButtonText("Desvincular").setWarning().onClick(async () => {
            await this.plugin.desvincular();
            this.refrescar();
          }));
        },
      },
    ];
  }

  private filasSinVincular(): Fila[] {
    let codigo = "";
    let nombreDispositivo = Platform.isMobile ? "Celular" : "PC";
    return [
      {
        name: "Código",
        armar: (s) => {
          s.setName("Código")
          .setDesc("En el panel web: Configuración → Conexiones → \"Vincular Obsidian\". "
            + "Pegá acá el código que te muestra.")
          .addText((t) => t.setPlaceholder("XXXX-XXXX").onChange((v) => { codigo = v.trim(); }));
        },
      },
      {
        name: "Nombre de este dispositivo",
        armar: (s) => {
          s.setName("Nombre de este dispositivo")
          .setDesc("Para reconocerlo en la lista de dispositivos vinculados.")
          .addText((t) => t.setValue(nombreDispositivo).onChange((v) => { nombreDispositivo = v.trim(); }));
        },
      },
      {
        name: "Vincular",
        armar: (s) => {
          s.setName("Vincular").addButton((b) => b.setButtonText("Vincular").setCta().onClick(async () => {
          if (!codigo) return;
          try {
            await this.plugin.vincular(codigo, nombreDispositivo);
            new Notice("Nori: vinculado.");
            this.refrescar();
          } catch (e) {
            s.setDesc(`${e}`);
          }
        }));
        },
      },
    ];
  }
}
