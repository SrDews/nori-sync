# Nori Sync

Sync your Obsidian vault with your [Nori](https://nori.study) account — a study platform for medical students. Link it once with a one-time code; no username or password stored in Obsidian.

*Español abajo.*

## How it works

1. In Nori: **Settings → Connections → Link Obsidian**. You get an 8-character code (valid 10 minutes, single use).
2. In Obsidian: **Settings → Nori Sync**, paste the code and press **Link**.
3. Sync with the ribbon button, or let it run automatically every few hours.

Safety rules built into the sync engine:

- **The first sync never deletes anything.** Files only on one side are copied to the other; files that differ on both sides keep both versions (`note (conflicto <date>).md`). You confirm the plan before it runs.
- Deletions go to the trash: locally, the one set in Obsidian's *Files and links → Deleted files*; on the server, a `.papelera/` folder. Five or more deletions in one sync ask for confirmation.
- Conflicts are never merged: both versions are kept.

## Disclosures

- **Account required.** You need a Nori account (accounts are by invitation to study groups).
- **Network use.** The plugin talks only to the Nori server (`https://nori.study`, configurable) to list, download, upload and move to trash the files of *your own* vault. Nothing else is sent anywhere.
- **No telemetry, no ads, no self-updating.**
- The device token is stored in the plugin's data in your vault; the server keeps only its SHA-256 hash. Unlinking from Nori's panel revokes it.

## Español

Sincroniza tu vault de Obsidian con tu cuenta de [Nori](https://nori.study).

1. En Nori: **Configuración → Conexiones → Vincular Obsidian** y copiá el código.
2. En Obsidian: **Configuración → Nori Sync**, pegá el código y tocá **Vincular**.

- **El primer sync nunca borra nada**: lo que está de un solo lado se copia al otro, y si un archivo difiere en los dos se guardan ambas versiones. Antes de aplicar, te muestra el resumen para confirmar.
- Los borrados van a la papelera: la que tengas configurada en Obsidian y `.papelera/` en el servidor.
- **Requiere cuenta de Nori** y se conecta solo al servidor de Nori, con tus propios archivos. Sin telemetría ni anuncios.

**Consejo:** usá un vault de Obsidian por cada cuenta de Nori. Si vinculás otra cuenta en el mismo vault, las notas que ya están ahí se suben a esa cuenta.

## Development

```
npm install
npm test
npm run build   # → main.js
```

## License

MIT
