/**
 * El motor de sync (§4 de PLAN_PLUGIN_OBSIDIAN). Sin imports de 'obsidian' a
 * propósito: es lógica pura, testeable con Node solo, sin un vault real ni
 * red — los efectos de lado (leer/escribir archivos, hablar HTTP) entran por
 * las dos interfaces de abajo, que implementa `adaptadores.ts`.
 *
 * El invariante que sostiene todo el módulo: SIN SNAPSHOT NO HAY BORRADOS.
 * Ninguna fila de `decidir()` borra si `snapshot` es `undefined` — no por una
 * guarda que se pueda sacar sin querer, sino porque ninguna rama de la tabla
 * lo permite. Eso es lo que hace que el primer sync de un vault ajeno nunca
 * pueda destruir material: en el primer sync el snapshot está vacío entero.
 */

export type Accion =
  | "subir"
  | "bajar"
  | "borrar_local"
  | "borrar_remoto"
  | "conflicto"
  | "nada"
  | "limpiar_snapshot";

/** La tabla de decisión, fila por fila (§4.1 del plan). Una ruta a la vez. */
export function decidir(
  local: string | undefined,
  remoto: string | undefined,
  snapshot: string | undefined,
): Accion {
  const L = local !== undefined;
  const R = remoto !== undefined;
  const S = snapshot !== undefined;

  if (L && !R && !S) return "subir";
  if (!L && R && !S) return "bajar";
  if (L && R && !S) return local === remoto ? "nada" : "conflicto";
  if (L && !R && S) return local === snapshot ? "borrar_local" : "subir";
  if (!L && R && S) return remoto === snapshot ? "borrar_remoto" : "bajar";
  if (L && R && S) {
    // Convergieron al mismo contenido — no importa que los dos hayan
    // cambiado respecto al snapshot, no hay nada que reconciliar. Mismo
    // criterio que la fila "sin snapshot" de arriba.
    if (local === remoto) return "nada";
    const localCambio = local !== snapshot;
    const remotoCambio = remoto !== snapshot;
    if (localCambio && remotoCambio) return "conflicto";
    return localCambio ? "subir" : "bajar";
  }
  // !L && !R && S: no está en ningún lado, pero el snapshot todavía lo recuerda.
  return "limpiar_snapshot";
}

/** `decidir()` para TODAS las rutas de los tres orígenes a la vez. */
export function planificar(
  local: Map<string, string>,
  remoto: Map<string, string>,
  snapshot: Map<string, string>,
): Map<string, Accion> {
  const rutas = new Set<string>([...local.keys(), ...remoto.keys(), ...snapshot.keys()]);
  const plan = new Map<string, Accion>();
  for (const ruta of rutas) {
    plan.set(ruta, decidir(local.get(ruta), remoto.get(ruta), snapshot.get(ruta)));
  }
  return plan;
}

/** Resumen del plan para el modal de confirmación (§1.2 y el freno de borrado masivo). */
export interface ResumenPlan {
  subir: number;
  bajar: number;
  conflicto: number;
  borrarLocal: number;
  borrarRemoto: number;
}

export function resumirPlan(plan: Map<string, Accion>): ResumenPlan {
  let subir = 0, bajar = 0, conflicto = 0, borrarLocal = 0, borrarRemoto = 0;
  for (const accion of plan.values()) {
    if (accion === "subir") subir++;
    else if (accion === "bajar") bajar++;
    else if (accion === "conflicto") conflicto++;
    else if (accion === "borrar_local") borrarLocal++;
    else if (accion === "borrar_remoto") borrarRemoto++;
  }
  return { subir, bajar, conflicto, borrarLocal, borrarRemoto };
}

/** Cuántos borrados en un solo sync alcanzan para pedir confirmación aun
 * fuera del primer sync — ponytail: constante fija, no un ajuste de UI;
 * si algún vault real la cruza sin ser un error, pasa a % del vault. */
export const UMBRAL_BORRADO_MASIVO = 5;

/**
 * El primer sync YA pedía confirmación para cualquier cambio (nunca hay
 * borrados ahí — invariante de `decidir()` arriba). Esto agrega el freno que
 * faltaba: un sync normal aplicaba cualquier cantidad de borrados sin
 * preguntar, y un vault local vaciado por error (a mano, o por un bug de
 * configuración) se replicaba entero al servidor en silencio.
 */
export function requiereConfirmacion(resumen: ResumenPlan, esPrimerSync: boolean): boolean {
  if (esPrimerSync) return resumen.subir + resumen.bajar + resumen.conflicto > 0;
  return resumen.borrarLocal + resumen.borrarRemoto >= UMBRAL_BORRADO_MASIVO;
}

/** `nombre.md` → `nombre (conflicto 2026-08-16 1402).md` (§4.3). */
export function nombrarConflicto(ruta: string, ahora: Date = new Date()): string {
  const punto = ruta.lastIndexOf(".");
  const base = punto === -1 ? ruta : ruta.slice(0, punto);
  const ext = punto === -1 ? "" : ruta.slice(punto);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sello = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())} `
    + `${pad(ahora.getHours())}${pad(ahora.getMinutes())}`;
  return `${base} (conflicto ${sello})${ext}`;
}

// ---------- Efectos de lado: implementados por `adaptadores.ts` ----------

export interface AdaptadorVault {
  /** ruta → hash16 de TODO lo que Obsidian ve, ya excluyendo `.obsidian`,
   * `.trash`, `.git` y cualquier ruta que empiece con punto — mismo criterio
   * que `vault._oculta()` del lado del servidor. */
  listar(): Promise<Map<string, string>>;
  leer(ruta: string): Promise<ArrayBuffer>;
  escribir(ruta: string, datos: ArrayBuffer): Promise<void>;
  /** A la papelera del SISTEMA operativo (`vault.trash(archivo, true)`),
   * nunca un borrado irreversible. */
  borrarAPapelera(ruta: string): Promise<void>;
}

export interface RespuestaServidor {
  ok: boolean;
  status: number;
}

export interface ClienteServidor {
  manifiesto(): Promise<{ modo: "escritura" | "lectura"; archivos: Map<string, string> }>;
  bajar(ruta: string): Promise<ArrayBuffer>;
  subir(ruta: string, datos: ArrayBuffer, ifMatch?: string): Promise<RespuestaServidor>;
  borrar(ruta: string): Promise<RespuestaServidor>;
}

/**
 * Envuelve un `ClienteServidor` para que el vault local pueda alinearse con
 * una SUBCARPETA del vault del servidor en vez de su raíz entera — el caso
 * real: `/root/apuntes` tiene una sola carpeta de primer nivel (`MED 3°`), y
 * quien ya sincronizaba por WebDAV apuntando ahí directo espera el mismo
 * vault "plano", sin ese nivel de más.
 *
 * A propósito NO se adivina sola (ninguna heurística tipo `raiz_materias()`
 * del servidor, que el propio `CLAUDE.md` documenta como "caduca" porque
 * cambia si el usuario agrega una carpeta desde Obsidian): es un campo que la
 * persona tipea una vez, o queda vacío y sincroniza el vault entero tal cual.
 */
export function conPrefijo(cliente: ClienteServidor, prefijo: string): ClienteServidor {
  const p = prefijo.replace(/^\/+|\/+$/g, "");
  if (!p) return cliente;
  const prefijoBarra = `${p}/`;
  const anteponer = (ruta: string) => `${p}/${ruta}`;

  return {
    async manifiesto() {
      const { modo, archivos } = await cliente.manifiesto();
      const recortado = new Map<string, string>();
      for (const [ruta, hash] of archivos) {
        if (ruta.startsWith(prefijoBarra)) recortado.set(ruta.slice(prefijoBarra.length), hash);
      }
      return { modo, archivos: recortado };
    },
    bajar: (ruta) => cliente.bajar(anteponer(ruta)),
    subir: (ruta, datos, ifMatch) => cliente.subir(anteponer(ruta), datos, ifMatch),
    borrar: (ruta) => cliente.borrar(anteponer(ruta)),
  };
}

export interface ResultadoSync {
  subidos: number;
  bajados: number;
  borradosLocal: number;
  borradosRemoto: number;
  conflictos: number;
  errores: string[];
}

function nuevoResultado(): ResultadoSync {
  return { subidos: 0, bajados: 0, borradosLocal: 0, borradosRemoto: 0, conflictos: 0, errores: [] };
}

export class Sincronizador {
  constructor(
    private vault: AdaptadorVault,
    private servidor: ClienteServidor,
    private snapshot: Map<string, string>,
    private guardarSnapshot: (snap: Map<string, string>) => Promise<void>,
  ) {}

  /** Solo calcula el plan — para el modal de confirmación del primer sync. */
  async planificarAhora(): Promise<{ plan: Map<string, Accion>; local: Map<string, string>; remoto: Map<string, string> }> {
    const local = await this.vault.listar();
    const { archivos: remoto } = await this.servidor.manifiesto();
    return { plan: planificar(local, remoto, this.snapshot), local, remoto };
  }

  /**
   * Ejecuta el sync. Orden (§4.5): bajadas → conflictos → subidas →
   * borrados remotos → borrados locales → poda del snapshot. Si se corta a
   * mitad de camino, el peor estado que deja es "faltan cosas por subir",
   * que el próximo sync arregla solo — el orden inverso dejaría borrados
   * aplicados sin sus reemplazos.
   *
   * El snapshot se persiste POR ARCHIVO, apenas ese archivo termina — no al
   * final. Un snapshot escrito solo al final, con un sync cortado a mitad de
   * camino, se contradice con lo que en verdad pasó y eso se traduce en
   * borrados espurios en la corrida siguiente.
   */
  async correr(soloLectura: boolean): Promise<ResultadoSync> {
    const resultado = nuevoResultado();
    const { plan, local, remoto } = await this.planificarAhora();

    for (const [ruta, accion] of plan) {
      if (accion !== "bajar") continue;
      try {
        await this.vault.escribir(ruta, await this.servidor.bajar(ruta));
        await this.marcarSincronizado(ruta, remoto.get(ruta));
        resultado.bajados++;
      } catch (e) {
        resultado.errores.push(`bajar ${ruta}: ${e}`);
      }
    }

    // Los conflictos corren para CUALQUIER rol: un observador puede tener
    // ediciones locales que ya no calzan con lo que bajó el servidor, y
    // perderlas en silencio es peor que no poder subir la copia (§4.3).
    for (const [ruta, accion] of plan) {
      if (accion !== "conflicto") continue;
      try {
        await this.resolverConflicto(ruta, soloLectura);
        resultado.conflictos++;
      } catch (e) {
        resultado.errores.push(`conflicto ${ruta}: ${e}`);
      }
    }

    if (!soloLectura) {
      for (const [ruta, accion] of plan) {
        if (accion !== "subir") continue;
        try {
          const datos = await this.vault.leer(ruta);
          const r = await this.servidor.subir(ruta, datos, remoto.get(ruta));
          if (r.status === 409) {
            // Alguien más escribió antes de que esta subida llegara: se
            // resuelve como un conflicto más, ahora mismo.
            await this.resolverConflicto(ruta, false);
            resultado.conflictos++;
          } else if (r.ok) {
            await this.marcarSincronizado(ruta, local.get(ruta));
            resultado.subidos++;
          } else {
            resultado.errores.push(`subir ${ruta}: HTTP ${r.status}`);
          }
        } catch (e) {
          resultado.errores.push(`subir ${ruta}: ${e}`);
        }
      }

      for (const [ruta, accion] of plan) {
        if (accion !== "borrar_remoto") continue;
        try {
          const r = await this.servidor.borrar(ruta);
          if (r.ok) {
            this.snapshot.delete(ruta);
            await this.guardarSnapshot(this.snapshot);
            resultado.borradosRemoto++;
          } else {
            resultado.errores.push(`borrar remoto ${ruta}: HTTP ${r.status}`);
          }
        } catch (e) {
          resultado.errores.push(`borrar remoto ${ruta}: ${e}`);
        }
      }
    }

    for (const [ruta, accion] of plan) {
      if (accion !== "borrar_local") continue;
      try {
        await this.vault.borrarAPapelera(ruta);
        this.snapshot.delete(ruta);
        await this.guardarSnapshot(this.snapshot);
        resultado.borradosLocal++;
      } catch (e) {
        resultado.errores.push(`borrar local ${ruta}: ${e}`);
      }
    }

    for (const [ruta, accion] of plan) {
      if (accion === "limpiar_snapshot") this.snapshot.delete(ruta);
    }
    await this.guardarSnapshot(this.snapshot);

    return resultado;
  }

  private async marcarSincronizado(ruta: string, hash: string | undefined) {
    if (hash === undefined) return;
    this.snapshot.set(ruta, hash);
    await this.guardarSnapshot(this.snapshot);
  }

  /**
   * La versión remota queda en la ruta original; la local se guarda aparte
   * y (si el rol lo permite) se sube también — visible desde los dos lados,
   * nunca un merge de contenido (§4.3: un merge de Markdown que sale mal es
   * indistinguible de una corrupción silenciosa).
   */
  private async resolverConflicto(ruta: string, soloLectura: boolean) {
    const datosLocales = await this.vault.leer(ruta);
    const datosRemotos = await this.servidor.bajar(ruta);
    await this.vault.escribir(ruta, datosRemotos);

    const copia = nombrarConflicto(ruta);
    await this.vault.escribir(copia, datosLocales);

    const { archivos } = await this.servidor.manifiesto();
    const hashRemotoFinal = archivos.get(ruta);
    if (hashRemotoFinal !== undefined) {
      this.snapshot.set(ruta, hashRemotoFinal);
    }

    if (!soloLectura) {
      await this.servidor.subir(copia, datosLocales);
      const { archivos: archivos2 } = await this.servidor.manifiesto();
      const hashCopia = archivos2.get(copia);
      if (hashCopia !== undefined) this.snapshot.set(copia, hashCopia);
    }

    await this.guardarSnapshot(this.snapshot);
  }
}
