// Empaqueta test/sync.test.ts (TypeScript, sin dependencias de 'obsidian') a
// un único CJS con esbuild y lo corre con el test runner nativo de Node — sin
// jest/mocha/ts-node, mismo criterio que la Python del repo: "a mano y sin
// framework". `npm test` llama a este archivo.
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const salida = path.join(aqui, ".sync.test.cjs");

buildSync({
  entryPoints: [path.join(aqui, "sync.test.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: salida,
  logLevel: "warning",
});

const r = spawnSync(process.execPath, ["--test", salida], { stdio: "inherit" });
process.exit(r.status ?? 1);
