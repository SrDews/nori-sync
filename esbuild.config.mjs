import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const banner = `/* Nori Sync — generado, no editar a mano. Fuente en src/. */`;
const produccion = process.argv[2] === "production";

const contexto = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: produccion ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: produccion,
});

if (produccion) {
  await contexto.rebuild();
  process.exit(0);
} else {
  await contexto.watch();
}
