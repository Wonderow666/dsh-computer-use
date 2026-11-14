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
			"zh-CN": {
				title: "电脑操作面板",
				loading: "正在载入面板…",
				help: "面板里可以按需截一张屏、点截图上的任意位置查它是什么控件、直接 invoke 控件，并查看动作日志。它和模型调用的是同一个 computer 工具，安全闸完全一致。",
				open: "在右侧栏打开面板",
				opened: "已请求打开右侧栏标签页。",
				failed: "打开失败："
			},
			en: {
				title: "Computer panel",
				loading: "Loading the panel…",
				help: "Screenshot on demand, click any pixel to learn which control is under it, invoke controls directly, and read the action log. It drives the same computer tool the model uses, with the same guards.",
				open: "Open the panel in the right sidebar",
				opened: "Asked the right sidebar to open the tab.",
				failed: "Could not open: "
			}
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

		// A settings entry is the reliable way in: the sidebar strip's add control
		// only lists what it knows, but every registered settings section is shown.
		function makeSettingsSection(ctx) {
			function PanelSettings() {
				const t = text();
				const [note, setNote] = (0, react.useState)("");
				const open = () => {
					try {
						ctx.sidebarRight.openTab(TAB_KIND);
						setNote(t.opened);
					} catch (err) {
						setNote(t.failed + " " + ((err && err.message) || err));
					}
				};
				return (0, react.createElement)("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 } },
					(0, react.createElement)("h3", { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t.title),
					(0, react.createElement)("p", { style: { margin: 0, opacity: 0.75, fontSize: 13, lineHeight: 1.6 } }, t.help),
					(0, react.createElement)("div", null,
						(0, react.createElement)("button", {
							type: "button",
							onClick: open,
							style: { padding: "4px 12px", borderRadius: 6, border: "1px solid #3a424d", background: "#222831", color: "inherit", cursor: "pointer" }
						}, t.open)
					),
					note ? (0, react.createElement)("p", { style: { margin: 0, fontSize: 12, opacity: 0.7 } }, note) : null
				);
			}
			return PanelSettings;
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
				try {
					offs.push(ctx.slots.inject("settings.section", () => ctx.slots.register({
						name: "settings.section",
						id: "dsh-computer-use-panel",
						order: 60,
						label: () => text().title
					}, makeSettingsSection(ctx))));
				} catch (err) {
					console.error("[dsh-computer-use] settings section not registered:", err);
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
