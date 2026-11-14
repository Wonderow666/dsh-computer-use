window.__ModuleLoader__.load({
	id: "dsh-computer-use",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// The host plugin mounts the panel on DSH's own web server at this prefix,
		// so the tab only has to frame a same-origin page: no token, no CORS.
		const PANEL_PATH = "/computer-use/panel/";
		const TAB_ID = "dsh-computer-use/panel";
		const TAB_KIND = "computer-use-panel";

		const copy = {
			"zh-CN": { title: "电脑操作面板", loading: "正在载入面板…" },
			en: { title: "Computer panel", loading: "Loading the panel…" }
		};
		function text() {
			const primary = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
			return String(primary).toLowerCase().startsWith("zh") ? copy["zh-CN"] : copy.en;
		}

		function PanelBody() {
			const style = {
				display: "block",
				width: "100%",
				height: "100%",
				minHeight: 420,
				border: "0",
				background: "#14161a"
			};
			return react.createElement("iframe", {
				src: PANEL_PATH,
				title: text().title,
				style,
				allow: "clipboard-read; clipboard-write"
			});
		}

		function apply(ctx) {
			ctx.effect(() => {
				// Both registrations live inside one effect so they vanish with the
				// plugin; a host without the right sidebar simply shows nothing.
				const offs = [];
				try {
					offs.push(ctx.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						priority: "extension",
						title: () => text().title
					}));
				} catch (err) {
					console.error("[dsh-computer-use] tab type not registered:", err);
				}
				try {
					offs.push(ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, PanelBody));
				} catch (err) {
					console.error("[dsh-computer-use] tab body not registered:", err);
				}
				return () => {
					for (const off of offs) {
						try { if (typeof off === "function") off(); } catch { /* already gone */ }
					}
				};
			}, "dsh-computer-use: panel tab");
		}

		const inject = ["slots", "sidebarRightTabs"];

		exports.PanelBody = PanelBody;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
