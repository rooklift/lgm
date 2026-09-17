"use strict";
/* The Tauri backend for window.api, the same interface preload.js gives the
 * renderer under Electron. Under Electron this file does nothing, since the
 * preload has already provided window.api; under Tauri the native side is
 * src-tauri/src/lib.rs, reached through invoke() and listen(). */
if (!window.api && window.__TAURI__) {
	(() => {
		let { invoke } = window.__TAURI__.core;
		let { listen } = window.__TAURI__.event;
		let { getCurrentWindow } = window.__TAURI__.window;

		/* Map bytes cross the IPC as JSON arrays; the renderer expects
		 * Uint8Array on the way in and hands one over on the way out. */
		function with_bytes(res) {
			if (res && res.data) res.data = Uint8Array.from(res.data);
			return res;
		}

		/* renderer callbacks registered through on_*, called from below */
		let load_map_cb = null;

		/* File objects synthesized from dropped paths, so path_for_file can
		 * answer for them the way Electron's webUtils does. */
		let paths = new WeakMap();

		window.api = {
			open_map: async () => with_bytes(await invoke("open_map")),
			path_for_file: file => paths.get(file) || null,
			on_load_map: cb => { load_map_cb = cb; },
			save_map: (file_path, data) => invoke("save_map", { path: file_path, data: Array.from(data) }),
			set_dirty: d => { invoke("set_dirty", { dirty: !!d }); },
			confirm_discard: () => invoke("confirm_discard"),
			show_error: (title, message) => { invoke("show_error", { title, message }); },
			on_menu: cb => { listen("menu-cmd", e => cb(e.payload)); },
			on_settings: cb => { invoke("get_settings").then(cb); },
			on_confirm_close: cb => { listen("confirm-close", () => cb()); },
			confirm_close: () => { invoke("close_confirmed"); },
		};

		/* Tauri intercepts native file drops itself and reports them as
		 * paths (the DOM drop event never carries the files on Windows), so
		 * swallow the DOM event before the renderer's own handler sees it,
		 * read the file natively, and replay it as a DOM drop of a File
		 * whose path we remember. The renderer then applies its usual size
		 * check and discard prompt. */
		window.addEventListener("drop", e => {
			if (!e.isTrusted) return; /* our own replay, below: let it through */
			e.preventDefault();
			e.stopImmediatePropagation();
		});

		async function open_path(p, replay) {
			let res = with_bytes(await invoke("read_map", { path: p }));
			if (res.error) {
				window.api.show_error("Could not open map", res.error);
				return;
			}
			if (!replay) {
				if (load_map_cb) load_map_cb({ path: res.path, data: res.data });
				return;
			}
			let name = res.path.replace(/^.*[\\/]/, "");
			let file = new File([res.data], name);
			paths.set(file, res.path);
			let dt = new DataTransfer();
			dt.items.add(file);
			let ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
			/* dispatched on the body so it bubbles to the renderer's window
			 * listener without passing through our own again */
			document.body.dispatchEvent(ev);
		}

		listen("tauri://drag-drop", e => {
			let p = e.payload && e.payload.paths && e.payload.paths[0];
			if (p) open_path(p, true);
		});

		/* a map opened from the Finder (macOS) after launch */
		listen("open-file", e => open_path(e.payload, true));

		/* On Windows the webview keeps the key events from ever reaching the
		 * native menu's accelerators (see build_menu in lib.rs), so the
		 * shortcuts are recognised here and sent back to the same handler a
		 * menu click uses. Elsewhere the native accelerators work, and doing
		 * it here too would run each command twice. */
		if (/Windows/.test(navigator.userAgent)) {
			const SHORTCUTS = {
				"KeyN": "new", "KeyO": "open", "KeyS": "save", "shift+KeyS": "save-as",
				"KeyZ": "undo", "KeyY": "redo", "KeyQ": "quit",
				"Equal": "zoom-in", "NumpadAdd": "zoom-in",
				"Minus": "zoom-out", "NumpadSubtract": "zoom-out",
				"Digit0": "zoom-fit", "Numpad0": "zoom-fit",
			};
			window.addEventListener("keydown", e => {
				if (!e.ctrlKey || e.altKey || e.metaKey) return;
				let id = SHORTCUTS[(e.shiftKey ? "shift+" : "") + e.code];
				if (!id) return;
				e.preventDefault();
				if (!e.repeat) invoke("menu_shortcut", { id });
			}, true);
		}

		/* Tauri doesn't follow document.title, which the renderer uses to
		 * show the file name and the dirty marker. */
		let title_el = document.querySelector("title");
		if (title_el) {
			new MutationObserver(() => { getCurrentWindow().setTitle(document.title); }).observe(title_el, { childList: true, characterData: true, subtree: true });
		}

		/* the map given on the command line, once the renderer is listening */
		window.addEventListener("DOMContentLoaded", () => {
			invoke("startup_map").then(res => {
				if (res && load_map_cb) load_map_cb(with_bytes(res));
				else if (res && res.error) window.api.show_error("Could not open map", res.error);
			});
		});

	})();
}
