# LGM

Bolo map editor, by Fable (with human oversight).

<img width="1077" height="816" alt="image" src="https://github.com/user-attachments/assets/3b3d562c-ef02-49d4-bc78-18f5f5d32237" />

The terrain sprites in `src/sprites/`, and the neighbour rules in `src/sprites.js` that select them (ported from `screencalc.c`), come from [WinBolo](https://github.com/kippandrew/winbolo) by John Morrison, GPL v2.

## Tauri build

`src-tauri/` holds a [Tauri](https://tauri.app) version of the editor: the same `src/` page, with the Electron main process replaced by a small Rust program (`src-tauri/src/lib.rs`) and `src/api.js` giving the renderer the same `window.api` it gets from `preload.js`. It builds a clickable app with no Electron needed: on Windows a single `LGM.exe` with the page compiled in, on macOS an `LGM.app`, on Linux an AppImage.

The GitHub Actions workflow in `.github/workflows/tauri.yml` builds all three on demand (Actions tab, "Run workflow") or on a `v*` tag, and attaches them to the run as artifacts. The macOS app is unsigned, so the first launch needs right-click → Open.

To build locally you need [Rust](https://rustup.rs), Node (for the Tauri CLI), and on Linux the [WebKitGTK packages](https://tauri.app/start/prerequisites/). Then:

```
cd src-tauri
npx @tauri-apps/cli@2 dev      # run it
npx @tauri-apps/cli@2 build    # the app lands under src-tauri/target/release/
```
