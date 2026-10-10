import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, Platform, requestUrl, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import { Sincronizador, resumirPlan, conPrefijo, requiereConfirmacion, UMBRAL_BORRADO_MASIVO, type ResumenPlan } from "./sync";
import { ObsidianVaultAdapter, HttpClienteServidor } from "./adaptadores";

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
};

export default class MedSyncPlugin extends Plugin {
  settings: MedSyncSettings = AJUSTES_DEFECTO;
  private itemStatusBar!: HTMLElement;
  private timerAutoSync: number | null = null;
  private sincronizando = false;

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
    this.settings.token = datos.token;
    this.settings.usuario = datos.usuario;
    this.settings.modo = datos.modo;
    await this.guardarAjustes();
    this.configurarAutoSync();
    this.actualizarStatusBar();
  }

  /** Solo olvida la vinculación LOCAL — revocar el dispositivo del lado del
   * servidor se hace desde el panel web (Configuración → Conexiones), que es
   * el lugar donde ya vive la lista completa de dispositivos de la persona. */
  async desvincular(): Promise<void> {
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
    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault, this.app.fileManager);
    const cliente = conPrefijo(
      new HttpClienteServidor(this.settings.servidor, this.settings.token!),
      this.settings.carpetaRemota,
    );
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
        new Notice(`Nori: ${r.errores.length} archivo(s) fallaron — mirá la consola.`);
      }
    } catch (e) {
      new Notice(`Nori: error — ${e}`);
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
    let carpetaRemotaValor = ajustes.carpetaRemota;
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
        name: "Carpeta remota",
        armar: (s) => {
          s.setName("Carpeta remota")
          .setDesc("Opcional: si el vault del servidor tiene una carpeta contenedora "
            + "(ej. \"MED 3°\") y querés que ESTE vault empiece directo ahí adentro, "
            + "sin ese nivel de más, escribila acá. Vacío = sincroniza el vault entero.")
          .addText((t) => t
            .setPlaceholder("ej. MED 3°")
            .setValue(carpetaRemotaValor)
            .onChange((v) => { carpetaRemotaValor = v; }))
          .addButton((b) => b.setButtonText("Aplicar").onClick(async () => {
            if (carpetaRemotaValor === ajustes.carpetaRemota) return;
            const huboSyncPrevio = Object.keys(ajustes.snapshot).length > 0;
            if (huboSyncPrevio && !await confirmar(this.app,
              "Cambiar la carpeta remota hace que el próximo sync revise todo de nuevo "
              + "(como un primer sync) — no borra nada sin haberlo visto antes, pero sí "
              + "te va a mostrar el conteo para confirmar. ¿Aplicar?")) return;
            ajustes.carpetaRemota = carpetaRemotaValor;
            ajustes.snapshot = {};   // las rutas cambiaron de raíz: no comparables contra lo viejo
            await this.plugin.guardarAjustes();
            new Notice("Nori: carpeta remota actualizada.");
          }));
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
