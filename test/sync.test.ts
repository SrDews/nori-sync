/**
 * Tests del motor de sync (sin red, sin vault real) — las 7 filas de la
 * tabla de decisión + el flujo completo de `Sincronizador` contra fakes en
 * memoria. `node:test`/`node:assert` porque son de la stdlib de Node: nada
 * que instalar aparte (mismo criterio que la Python del repo, "a mano y sin
 * framework").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidir,
  planificar,
  resumirPlan,
  requiereConfirmacion,
  UMBRAL_BORRADO_MASIVO,
  nombrarConflicto,
  conPrefijo,
  Sincronizador,
  type AdaptadorVault,
  type ClienteServidor,
  type RespuestaServidor,
} from "../src/sync";

// ---------- decidir(): las 7 filas de §4.1 ----------

test("local solo → subir", () => {
  assert.equal(decidir("a", undefined, undefined), "subir");
});

test("remoto solo → bajar", () => {
  assert.equal(decidir(undefined, "a", undefined), "bajar");
});

test("local y remoto, sin snapshot, iguales → nada", () => {
  assert.equal(decidir("a", "a", undefined), "nada");
});

test("local y remoto, sin snapshot, distintos → conflicto (primer sync = unión, nunca borra)", () => {
  assert.equal(decidir("a", "b", undefined), "conflicto");
});

test("local + snapshot, sin remoto, sin cambios → borrar_local (lo borraron del otro lado)", () => {
  assert.equal(decidir("a", undefined, "a"), "borrar_local");
});

test("local + snapshot, sin remoto, local cambió → subir (la edición gana al borrado)", () => {
  assert.equal(decidir("b", undefined, "a"), "subir");
});

test("remoto + snapshot, sin local, sin cambios → borrar_remoto", () => {
  assert.equal(decidir(undefined, "a", "a"), "borrar_remoto");
});

test("remoto + snapshot, sin local, remoto cambió → bajar (la edición gana al borrado)", () => {
  assert.equal(decidir(undefined, "b", "a"), "bajar");
});

test("los tres, nada cambió → nada", () => {
  assert.equal(decidir("a", "a", "a"), "nada");
});

test("los tres, solo local cambió → subir", () => {
  assert.equal(decidir("b", "a", "a"), "subir");
});

test("los tres, solo remoto cambió → bajar", () => {
  assert.equal(decidir("a", "b", "a"), "bajar");
});

test("los tres, los dos cambiaron distinto → conflicto", () => {
  assert.equal(decidir("b", "c", "a"), "conflicto");
});

test("los tres, los dos cambiaron IGUAL → nada (llegaron al mismo lugar)", () => {
  assert.equal(decidir("b", "b", "a"), "nada");
});

test("nada en ningún lado salvo el snapshot → limpiar_snapshot", () => {
  assert.equal(decidir(undefined, undefined, "a"), "limpiar_snapshot");
});

// El invariante central del plan: SIN snapshot, NINGUNA fila borra.
test("invariante: sin snapshot, ninguna combinación produce un borrado", () => {
  const valores = ["a", "b", undefined];
  for (const l of valores) for (const r of valores) {
    const accion = decidir(l, r, undefined);
    assert.notEqual(accion, "borrar_local", `local=${l} remoto=${r}`);
    assert.notEqual(accion, "borrar_remoto", `local=${l} remoto=${r}`);
  }
});

// ---------- planificar() / resumirPlan() ----------

test("planificar cubre la unión de las tres fuentes", () => {
  const local = new Map([["a", "1"], ["b", "1"]]);
  const remoto = new Map([["b", "1"], ["c", "1"]]);
  const snapshot = new Map([["b", "1"], ["d", "1"]]);
  const plan = planificar(local, remoto, snapshot);
  assert.equal(plan.size, 4); // a, b, c, d
  assert.equal(plan.get("a"), "subir");
  assert.equal(plan.get("b"), "nada");
  assert.equal(plan.get("c"), "bajar");
  assert.equal(plan.get("d"), "limpiar_snapshot");
});

test("resumirPlan cuenta subir/bajar/conflicto/borrar_local/borrar_remoto, ignora nada/limpiar_snapshot", () => {
  const plan = new Map<string, ReturnType<typeof decidir>>([
    ["a", "subir"], ["b", "subir"], ["c", "bajar"], ["d", "conflicto"],
    ["e", "nada"], ["f", "borrar_local"], ["g", "borrar_remoto"], ["h", "limpiar_snapshot"],
  ]);
  assert.deepEqual(resumirPlan(plan), { subir: 2, bajar: 1, conflicto: 1, borrarLocal: 1, borrarRemoto: 1 });
});

// ---------- requiereConfirmacion(): el freno de borrado masivo ----------

test("primer sync: confirma si hay cualquier cambio (nunca hay borrados en un primer sync)", () => {
  const sinCambios = { subir: 0, bajar: 0, conflicto: 0, borrarLocal: 0, borrarRemoto: 0 };
  assert.equal(requiereConfirmacion(sinCambios, true), false);
  const conCambios = { ...sinCambios, bajar: 1 };
  assert.equal(requiereConfirmacion(conCambios, true), true);
});

test("sync normal: NO confirma por debajo del umbral", () => {
  const resumen = {
    subir: 0, bajar: 0, conflicto: 0,
    borrarLocal: UMBRAL_BORRADO_MASIVO - 1, borrarRemoto: 0,
  };
  assert.equal(requiereConfirmacion(resumen, false), false);
});

test("sync normal: confirma al llegar al umbral, sumando local + remoto", () => {
  const resumen = { subir: 0, bajar: 0, conflicto: 0, borrarLocal: 2, borrarRemoto: UMBRAL_BORRADO_MASIVO - 2 };
  assert.equal(requiereConfirmacion(resumen, false), true);
});

test("sync normal: subir/bajar/conflicto sueltos, sin borrados, NO confirman (ya no es el primer sync)", () => {
  const resumen = { subir: 10, bajar: 10, conflicto: 10, borrarLocal: 0, borrarRemoto: 0 };
  assert.equal(requiereConfirmacion(resumen, false), false);
});

// ---------- nombrarConflicto() ----------

test("nombrarConflicto conserva la extensión y arma el sello de fecha", () => {
  const fecha = new Date(2026, 7, 16, 14, 2); // 2026-08-16 14:02 (mes 0-index)
  assert.equal(nombrarConflicto("MED/clase.md", fecha), "MED/clase (conflicto 2026-08-16 1402).md");
});

test("nombrarConflicto sin extensión no revienta", () => {
  const fecha = new Date(2026, 7, 16, 14, 2);
  assert.equal(nombrarConflicto("MED/LEEME", fecha), "MED/LEEME (conflicto 2026-08-16 1402)");
});

// ---------- conPrefijo(): alinear el vault local con una subcarpeta ----------

test("conPrefijo vacío devuelve el mismo cliente (sin envoltorio)", () => {
  const cliente = {} as ClienteServidor;
  assert.equal(conPrefijo(cliente, ""), cliente);
});

test("conPrefijo recorta el prefijo del manifiesto y descarta lo que queda afuera", async () => {
  const base: ClienteServidor = {
    async manifiesto() {
      return {
        modo: "escritura",
        archivos: new Map([
          ["MED 3°/EPS/clase.md", "h1"],
          ["MED 3°/FISIOLOGIA/otra.md", "h2"],
          ["MED 3° (I)/.space/basura", "h3"],   // el mismo prefijo como texto, pero NO como carpeta
          ["otra_cosa.md", "h4"],
        ]),
      };
    },
    bajar: async () => new ArrayBuffer(0),
    subir: async () => ({ ok: true, status: 200 }),
    borrar: async () => ({ ok: true, status: 200 }),
  };
  const envuelto = conPrefijo(base, "MED 3°");
  const { archivos } = await envuelto.manifiesto();
  assert.deepEqual(Object.fromEntries(archivos), {
    "EPS/clase.md": "h1",
    "FISIOLOGIA/otra.md": "h2",
  });
  // "MED 3° (I)/..." NO matchea "MED 3°/" — el chequeo exige la barra exacta.
  assert.ok(!archivos.has("(I)/.space/basura"));
});

test("conPrefijo antepone el prefijo al bajar/subir/borrar", async () => {
  const vistas: string[] = [];
  const base: ClienteServidor = {
    manifiesto: async () => ({ modo: "escritura", archivos: new Map() }),
    bajar: async (ruta) => { vistas.push(`bajar:${ruta}`); return new ArrayBuffer(0); },
    subir: async (ruta) => { vistas.push(`subir:${ruta}`); return { ok: true, status: 200 }; },
    borrar: async (ruta) => { vistas.push(`borrar:${ruta}`); return { ok: true, status: 200 }; },
  };
  const envuelto = conPrefijo(base, "/MED 3°/");   // barras de más, se recortan
  await envuelto.bajar("EPS/clase.md");
  await envuelto.subir("EPS/clase.md", new ArrayBuffer(0));
  await envuelto.borrar("EPS/clase.md");
  assert.deepEqual(vistas, [
    "bajar:MED 3°/EPS/clase.md",
    "subir:MED 3°/EPS/clase.md",
    "borrar:MED 3°/EPS/clase.md",
  ]);
});

test("un Sincronizador con conPrefijo sincroniza como si el prefijo fuera la raíz", async () => {
  const vault = new VaultFalso();   // vacío: primer sync, baja todo lo de adentro del prefijo
  const servidor = new ServidorFalso();
  servidor.archivos.set("MED 3°/EPS/a.md", "contenido A");
  servidor.archivos.set("MED 3°/FISIOLOGIA/b.md", "contenido B");
  servidor.archivos.set("Tags/index.md", "no debería bajar esto");
  const cliente = conPrefijo(servidor, "MED 3°");
  const snapshot = new Map<string, string>();
  const sinc = new Sincronizador(vault, cliente, snapshot, async () => {});

  const r = await sinc.correr(false);
  assert.equal(r.bajados, 2);
  assert.equal(vault.archivos.get("EPS/a.md"), "contenido A");
  assert.equal(vault.archivos.get("FISIOLOGIA/b.md"), "contenido B");
  assert.ok(![...vault.archivos.keys()].some((k) => k.includes("Tags")), "lo de afuera del prefijo no baja");
});

// ---------- Fakes para el flujo completo ----------

function aBuffer(texto: string): ArrayBuffer {
  return new TextEncoder().encode(texto).buffer as ArrayBuffer;
}
function deBuffer(datos: ArrayBuffer): string {
  return new TextDecoder().decode(datos);
}

class VaultFalso implements AdaptadorVault {
  archivos = new Map<string, string>();   // ruta -> contenido (hace de "hash": alcanza para test)
  papelera: string[] = [];

  async listar(): Promise<Map<string, string>> {
    return new Map(this.archivos);
  }
  async leer(ruta: string): Promise<ArrayBuffer> {
    if (!this.archivos.has(ruta)) throw new Error(`no existe: ${ruta}`);
    return aBuffer(this.archivos.get(ruta)!);
  }
  async escribir(ruta: string, datos: ArrayBuffer): Promise<void> {
    this.archivos.set(ruta, deBuffer(datos));
  }
  async borrarAPapelera(ruta: string): Promise<void> {
    this.papelera.push(ruta);
    this.archivos.delete(ruta);
  }
}

class ServidorFalso implements ClienteServidor {
  archivos = new Map<string, string>();
  modo: "escritura" | "lectura" = "escritura";
  llamadasSubir = 0;
  llamadasManifiesto = 0;
  /** Si está seteado, la PRIMERA llamada a manifiesto() devuelve esta foto
   * vieja en vez del estado real — simula que otro dispositivo escribió
   * DESPUÉS de que este ya había planificado, y antes de subir de verdad. */
  manifiestoPrimeraLlamada?: Map<string, string>;

  async manifiesto() {
    this.llamadasManifiesto++;
    if (this.llamadasManifiesto === 1 && this.manifiestoPrimeraLlamada) {
      return { modo: this.modo, archivos: new Map(this.manifiestoPrimeraLlamada) };
    }
    return { modo: this.modo, archivos: new Map(this.archivos) };
  }
  async bajar(ruta: string): Promise<ArrayBuffer> {
    if (!this.archivos.has(ruta)) throw new Error(`no existe en el servidor: ${ruta}`);
    return aBuffer(this.archivos.get(ruta)!);
  }
  async subir(ruta: string, datos: ArrayBuffer, ifMatch?: string): Promise<RespuestaServidor> {
    this.llamadasSubir++;
    if (ifMatch !== undefined) {
      const actual = this.archivos.get(ruta);
      if (actual !== ifMatch) return { ok: false, status: 409 };
    }
    this.archivos.set(ruta, deBuffer(datos));
    return { ok: true, status: 200 };
  }
  async borrar(ruta: string): Promise<RespuestaServidor> {
    this.archivos.delete(ruta);
    return { ok: true, status: 200 };
  }
}

function sincronizador(vault: VaultFalso, servidor: ServidorFalso, snapshotInicial: Record<string, string> = {}) {
  const snapshot = new Map(Object.entries(snapshotInicial));
  const guardados: Array<Record<string, string>> = [];
  const guardarSnapshot = async (s: Map<string, string>) => {
    guardados.push(Object.fromEntries(s));
  };
  const sinc = new Sincronizador(vault, servidor, snapshot, guardarSnapshot);
  return { sinc, snapshot, guardados };
}

// ---------- Flujo completo: bootstrap ----------

test("primer sync: remoto vacío, local con archivos → sube todo, nada se pierde", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "contenido A");
  vault.archivos.set("b.md", "contenido B");
  const servidor = new ServidorFalso();
  const { sinc } = sincronizador(vault, servidor);

  const r = await sinc.correr(false);
  assert.equal(r.subidos, 2);
  assert.equal(r.bajados, 0);
  assert.equal(r.conflictos, 0);
  assert.equal(servidor.archivos.get("a.md"), "contenido A");
  assert.equal(servidor.archivos.get("b.md"), "contenido B");
});

test("primer sync: local vacío, remoto con archivos → baja todo", async () => {
  const vault = new VaultFalso();
  const servidor = new ServidorFalso();
  servidor.archivos.set("a.md", "contenido A");
  const { sinc } = sincronizador(vault, servidor);

  const r = await sinc.correr(false);
  assert.equal(r.bajados, 1);
  assert.equal(vault.archivos.get("a.md"), "contenido A");
});

test("primer sync: los dos con contenido, un archivo compartido difiere → unión, se conservan las DOS versiones", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("solo_local.md", "x");
  vault.archivos.set("compartido.md", "version local");
  const servidor = new ServidorFalso();
  servidor.archivos.set("solo_remoto.md", "y");
  servidor.archivos.set("compartido.md", "version remota");
  const { sinc } = sincronizador(vault, servidor);

  const r = await sinc.correr(false);
  assert.equal(r.conflictos, 1);
  // Nada se perdió: las 4 rutas originales + la copia de conflicto existen.
  assert.equal(vault.archivos.get("solo_local.md"), "x");
  assert.equal(vault.archivos.get("solo_remoto.md"), "y");
  assert.equal(servidor.archivos.get("solo_local.md"), "x");
  assert.equal(vault.archivos.get("compartido.md"), "version remota"); // la remota queda en el original
  const copia = [...vault.archivos.keys()].find((k) => k.startsWith("compartido (conflicto"));
  assert.ok(copia, "debe existir una copia de conflicto local");
  assert.equal(vault.archivos.get(copia!), "version local");
  assert.equal(servidor.archivos.get(copia!), "version local", "la copia también se sube");
});

// ---------- Estado estable ----------

test("segundo sync sin cambios: no hace nada", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "x");
  const servidor = new ServidorFalso();
  servidor.archivos.set("a.md", "x");
  const { sinc } = sincronizador(vault, servidor, { "a.md": "x" });

  const r = await sinc.correr(false);
  assert.deepEqual(r, { subidos: 0, bajados: 0, borradosLocal: 0, borradosRemoto: 0, conflictos: 0, errores: [] });
});

test("edición local → sube; edición remota → baja", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "editado local");
  vault.archivos.set("b.md", "sin cambios");
  const servidor = new ServidorFalso();
  servidor.archivos.set("a.md", "original");
  servidor.archivos.set("b.md", "editado remoto");
  const { sinc } = sincronizador(vault, servidor, { "a.md": "original", "b.md": "sin cambios" });

  const r = await sinc.correr(false);
  assert.equal(r.subidos, 1);
  assert.equal(r.bajados, 1);
  assert.equal(servidor.archivos.get("a.md"), "editado local");
  assert.equal(vault.archivos.get("b.md"), "editado remoto");
});

// ---------- Borrados: SIEMPRE vía papelera, nunca destructivos ----------

test("borrado local (existía en snapshot, ya no está local) → borra del servidor, no reaparece", async () => {
  const vault = new VaultFalso();   // el usuario ya lo borró de su Obsidian
  const servidor = new ServidorFalso();
  servidor.archivos.set("a.md", "x");
  const { sinc } = sincronizador(vault, servidor, { "a.md": "x" });

  const r = await sinc.correr(false);
  assert.equal(r.borradosRemoto, 1);
  assert.ok(!servidor.archivos.has("a.md"));
});

test("borrado remoto → se lleva la copia local a la papelera del SISTEMA, no un borrado directo", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "x");
  const servidor = new ServidorFalso();   // ya lo borraron del lado del servidor
  const { sinc } = sincronizador(vault, servidor, { "a.md": "x" });

  const r = await sinc.correr(false);
  assert.equal(r.borradosLocal, 1);
  assert.ok(!vault.archivos.has("a.md"));
  assert.deepEqual(vault.papelera, ["a.md"]);
});

// ---------- Modo lectura: nunca escribe al servidor ----------

test("observador: edición local (el servidor no cambió) NUNCA se sube ni se pisa — queda como está, sin sincronizar", async () => {
  // Sin cambio del lado del servidor no hay nada nuevo que bajar: la acción
  // es "subir", y para un observador eso se salta entero (igual que ya pasa
  // hoy con WebDAV: "el servidor rechaza la subida"). Distinto del caso de
  // conflicto real (siguiente test), donde el servidor SÍ cambió y por eso
  // hay contenido nuevo que reconciliar.
  const vault = new VaultFalso();
  vault.archivos.set("edite_esto.md", "mi copia editada");
  vault.archivos.set("lo_borraron.md", "viejo");
  const servidor = new ServidorFalso();
  servidor.modo = "lectura";
  servidor.archivos.set("edite_esto.md", "original del servidor");
  servidor.archivos.set("nuevo_del_grupo.md", "clase nueva");
  const { sinc } = sincronizador(vault, servidor, { "edite_esto.md": "original del servidor", "lo_borraron.md": "viejo" });

  const r = await sinc.correr(true);
  assert.equal(r.subidos, 0, "un observador nunca sube");
  assert.equal(servidor.llamadasSubir, 0, "ni siquiera lo intenta contra el servidor");
  assert.equal(vault.archivos.get("edite_esto.md"), "mi copia editada", "no hay nada nuevo que bajar, así que su copia queda intacta");
  assert.equal(vault.archivos.get("nuevo_del_grupo.md"), "clase nueva", "pero SÍ recibe material nuevo del grupo");
  assert.ok(!vault.archivos.has("lo_borraron.md"), "los borrados remotos SÍ se reflejan localmente");
});

test("observador con conflicto real: conserva su copia local (no la pierde), pero no la sube", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "mi version");
  const servidor = new ServidorFalso();
  servidor.modo = "lectura";
  servidor.archivos.set("a.md", "otra version");
  const { sinc } = sincronizador(vault, servidor, { "a.md": "original" });

  const r = await sinc.correr(true);
  assert.equal(r.conflictos, 1);
  assert.equal(vault.archivos.get("a.md"), "otra version");
  const copia = [...vault.archivos.keys()].find((k) => k.startsWith("a (conflicto"));
  assert.ok(copia, "la copia local del observador no se pierde");
  assert.equal(vault.archivos.get(copia!), "mi version");
  assert.ok(!servidor.archivos.has(copia!), "pero un observador no la sube");
});

// ---------- 409 durante la subida: otro dispositivo llegó primero ----------

test("409 al subir (otro dispositivo ganó la carrera) se resuelve como conflicto, no se pierde la edición", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "mi edición");
  const servidor = new ServidorFalso();
  // Lo que este dispositivo VIO al planificar (por eso decide "subir": para
  // él, remoto == snapshot == "original", solo cambió lo local)...
  servidor.manifiestoPrimeraLlamada = new Map([["a.md", "original"]]);
  // ...pero la realidad, al momento de subir de verdad, ya es otra: alguien
  // más escribió en el medio. El If-Match no calza → 409.
  servidor.archivos.set("a.md", "alguien más ya subió esto");
  const { sinc } = sincronizador(vault, servidor, { "a.md": "original" });

  const r = await sinc.correr(false);
  assert.equal(r.conflictos, 1);
  assert.equal(r.subidos, 0);
  assert.equal(vault.archivos.get("a.md"), "alguien más ya subió esto");
  const copia = [...vault.archivos.keys()].find((k) => k.startsWith("a (conflicto"));
  assert.ok(copia, "la edición que perdió la carrera no desaparece");
  assert.equal(vault.archivos.get(copia!), "mi edición");
});

// ---------- El snapshot se persiste por archivo, no solo al final ----------

test("el snapshot se guarda más de una vez durante un sync con varios archivos (no solo al final)", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "1");
  vault.archivos.set("b.md", "2");
  vault.archivos.set("c.md", "3");
  const servidor = new ServidorFalso();
  const { sinc, guardados } = sincronizador(vault, servidor);

  await sinc.correr(false);
  assert.ok(guardados.length >= 3, `se esperaban >=3 guardados intermedios, hubo ${guardados.length}`);
});

test("snapshot final: después de un sync limpio, refleja exactamente el estado sincronizado", async () => {
  const vault = new VaultFalso();
  vault.archivos.set("a.md", "1");
  const servidor = new ServidorFalso();
  const { sinc, snapshot } = sincronizador(vault, servidor);

  await sinc.correr(false);
  assert.deepEqual(Object.fromEntries(snapshot), { "a.md": "1" });

  // Un segundo sync inmediato, sin cambios de ningún lado, no debe alterar nada.
  const r2 = await sinc.correr(false);
  assert.deepEqual(r2, { subidos: 0, bajados: 0, borradosLocal: 0, borradosRemoto: 0, conflictos: 0, errores: [] });
});

// ---------- Vaults Nori (PLAN_VAULTS_NORI): FOTOS/, enlaces, mezcla y caché ----------
import { planFotos, reubicarEnlaces, decidirCambioVault, enlaceEsDeFoto, hashEnCache, fotoBienUbicada } from "../src/vaults";

test("planFotos: vinculado a un Vault Nori, toda foto fuera de FOTOS/ va a FOTOS/ (choque → « (2)»)", () => {
  const { mapa, sinLugar } = planFotos(["adjuntos/a.png", "x/a.png", "FOTOS/b.png", "nota.md", ".obsidian/i.png"], false);
  assert.deepEqual([...mapa], [["adjuntos/a.png", "FOTOS/a.png"], ["x/a.png", "FOTOS/a (2).png"]]);
  assert.deepEqual(sinLugar, []);
});

test("planFotos: sincronizando todo, la foto va a FOTOS/ de su carpeta de primer nivel; en la raíz no hay lugar", () => {
  const { mapa, sinLugar } = planFotos(["MED 3°/adjuntos/a.png", "MED 3°/FOTOS/b.png", "suelta.png"], true);
  assert.deepEqual([...mapa], [["MED 3°/adjuntos/a.png", "MED 3°/FOTOS/a.png"]]);
  assert.deepEqual(sinLugar, ["suelta.png"]);
  assert.equal(fotoBienUbicada("MED 3°/FOTOS/b.png", true), true);
});

test("reubicarEnlaces: rutas completas en notas, nombre suelto en canvas; un [[nombre]] suelto no se toca", () => {
  const mapa = new Map([["adjuntos/Pasted image 1.png", "FOTOS/Pasted image 1.png"]]);
  const md = reubicarEnlaces("![[adjuntos/Pasted image 1.png|200]] ![[Pasted image 1.png]] ![x](adjuntos/Pasted%20image%201.png)", "md", mapa);
  assert.equal(md.texto, "![[FOTOS/Pasted image 1.png|200]] ![[Pasted image 1.png]] ![x](FOTOS/Pasted%20image%201.png)");
  assert.equal(md.cambios, 2);
  const canvas = reubicarEnlaces('{"nodes":[{"id":"n1","type":"file","file":"Pasted image 1.png"},{"id":"n2","type":"text","text":"hola"}],"edges":[]}', "canvas", mapa);
  assert.equal(canvas.cambios, 1);
  assert.equal((JSON.parse(canvas.texto) as { nodes: Array<{ file?: string }> }).nodes[0].file, "FOTOS/Pasted image 1.png");
  assert.equal(reubicarEnlaces("{roto", "canvas", mapa).cambios, 0);
});

test("decidirCambioVault, enlaceEsDeFoto, planFotos con excluidas y hashEnCache", () => {
  assert.equal(decidirCambioVault("Corte 1", "Corte 2", 0), "directo");
  assert.equal(decidirCambioVault("Corte 1", "Corte 2", 4), "preguntar");     // se subiría todo a Corte 2
  assert.equal(decidirCambioVault("", "Corte 2", 4), "bloquear");             // se anidaría todo un nivel
  assert.equal(enlaceEsDeFoto("FOTOS/a.png", "adj/a.png", "FOTOS/a.png"), true);
  assert.equal(enlaceEsDeFoto("fig", "adj/a.png", "FOTOS/a.png"), false);
  assert.equal(planFotos(["adj/a.png"], false, new Set(["adj/a.png"])).mapa.size, 0);
  assert.equal(hashEnCache({ "a.md": { m: 1, s: 2, h: "abc" } }, "a.md", 1, 2), "abc");
  assert.equal(hashEnCache({ "a.md": { m: 1, s: 2, h: "abc" } }, "a.md", 1, 3), null);
});
