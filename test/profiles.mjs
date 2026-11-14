// Checks for the app-profile layer (lib/profiles.js + the plugin's use of it).
//
// Profiles are the "knowledge as data" half of the plugin: which window an app
// is, what its controls are called, and which step sequences already worked.
// Here the engine is mocked (test/mock/stub-cp.mjs), so this runs anywhere -
// no desktop, no focus stealing, no cu.exe.
//
//   node test/profiles.mjs
import { register } from "node:module";
import {
  normalizeProfiles,
  describeProfiles,
  matchProfile,
  findProfile,
  planSource,
  substitute,
  applyAliasesToSteps,
  windowMatches
} from "../lib/profiles.js";

register("./mock/hooks.mjs", import.meta.url);
const { loadTool } = await import("./_harness.mjs");
const { calls, state } = await import("./mock/stub-cp.mjs");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}
async function throws(fn, needle) {
  try {
    await fn();
    return { ok: false, why: "did not throw" };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: !needle || msg.includes(needle), why: msg };
  }
}

// ---------------------------------------------------------------- matching ---
check("process match ignores case", windowMatches({ process: "PacketTracer.exe" }, { process: "packettracer.exe" }));
check("class match needs equality, not substring", !windowMatches({ class: "Qt5" }, { class: "Qt51516QWindowIcon" }));
check("class match accepts a glob", windowMatches({ class: "Qt5*" }, { class: "Qt51516QWindowIcon" }));
check("title match is a regex", windowMatches({ title: "\\bWord$" }, { title: "报告.docx - Word" }));
check("several keys are ANDed", !windowMatches({ process: "notepad.exe", title: "Save" }, { process: "notepad.exe", title: "Untitled" }));
check("an empty match never matches", !windowMatches({}, { process: "x.exe" }));

// --------------------------------------------------------------- profiles ---
const list = normalizeProfiles({
  pt: {
    match: { process: "PacketTracer.exe", class: "Qt5*" },
    notes: "palette sits at y=1404",
    aliases: { list: "0.1", addLink: "0.2.2" },
    plans: { open: "key ctrl+shift+l\nwait /工作区列表/ 4000", type: ["type hello", "key Return"] }
  },
  notepad: { match: { process: "notepad.exe" }, plans: { save: "key ctrl+s" } }
});
check("object form normalizes to a list", list.length === 2 && list[0].id === "pt");
check("array form is accepted too", normalizeProfiles([{ id: "a", plans: { p: "read" } }])[0].id === "a");
check("plan arrays become text", list[0].plans.type === "type hello\nkey Return");
check("describe hides plan bodies but keeps names", (() => {
  const d = describeProfiles(list).find((p) => p.id === "pt");
  return d.plans.length === 2 && d.aliases.join(",") === "list,addLink" && !JSON.stringify(d).includes("ctrl+shift");
})());
check("matchProfile picks the right profile", matchProfile(list, { process: "notepad.exe" }).id === "notepad");
check("matchProfile returns null when nothing matches", matchProfile(list, { process: "explorer.exe" }) === null);
check("findProfile is case-insensitive", findProfile(list, "NOTEPAD").id === "notepad");
check("findProfile explains the configured names", (await throws(() => findProfile(list, "nope"), "configured profiles: pt, notepad")).ok);
check("findProfile explains when none exist", (await throws(() => findProfile([], "nope"), "no profiles are configured")).ok);
check("a profile with one plan may omit the name", planSource(list[1]) === "key ctrl+s");
check("a profile with many plans demands a name", (await throws(() => planSource(list[0]), "name one of: open, type")).ok);
check("an unknown plan lists the real ones", (await throws(() => planSource(list[0], "close"), "plans: open, type")).ok);
check("substitute resolves aliases", substitute("invoke {{addLink}} keep {{ list }}", list[0].aliases) === "invoke 0.2.2 keep 0.1");
check("an unknown alias lists the known ones", (() => {
  try {
    substitute("{{oops}}", list[0].aliases);
    return false;
  } catch (e) {
    return e.message.includes("this profile defines: list, addLink");
  }
})());
check("aliases only touch the argument part", (() => {
  const steps = applyAliasesToSteps([{ op: "invoke", rest: "{{list}}" }], list[0].aliases);
  return steps[0].op === "invoke" && steps[0].rest === "0.1";
})());

// ------------------------------------------------------------ the tool side ---
const cfg = { profiles: { notepad: { match: { process: "notepad.exe" }, aliases: { box: "0.1.1" }, plans: { hello: "type hello world", many: "read\nread" } } } };
const { tool, run } = await loadTool(cfg);

check("the action enum includes profiles", tool.parameters.properties.action.enum.includes("profiles"));
check("the schema documents profile and task", Boolean(tool.parameters.properties.profile && tool.parameters.properties.task));

const listing = await run({ action: "profiles" });
check("action=profiles lists the configured profile", listing.count === 1 && listing.profiles[0].id === "notepad");
check("the listing does not leak plan bodies", !JSON.stringify(listing).includes("hello world"));

const empty = await loadTool({});
const noProfiles = await empty.run({ action: "profiles" });
check("with no profiles configured the action is empty, not an error", noProfiles.count === 0);

// state names the profile that owns the foreground window. The stub's
// foreground is chrome.exe, which the profile does not match.
const st = await run({ action: "state" });
check("state reports no match for a foreign foreground", st.profile && st.profile.matched === false, JSON.stringify(st.profile));
check("state still lists what is configured", Array.isArray(st.profile.configured) && st.profile.configured.includes("notepad"));

const chromeCfg = { profiles: { harness: { match: { process: "chrome.exe" } } } };
const chrome = await loadTool(chromeCfg);
const st2 = await chrome.run({ action: "state" });
check("state names the profile when the foreground matches", st2.profile.matched === true && st2.profile.id === "harness");

// A saved plan replays with the profile's window, and needs no hwnd from the caller.
calls.length = 0;
const played = await run({ action: "run", profile: "notepad", task: "hello" });
check("run accepts profile + task", played.text.includes("done 1/1"), played.text.replace(/\n/g, " | "));
const focusCall = calls.find((c) => c.argv[0] === "focus");
check("the profile supplies the target window", focusCall && focusCall.argv.includes("999001"), focusCall ? focusCall.argv.join(" ") : "no focus call");
const typeCall = calls.find((c) => c.argv[0] === "type");
check("the plan runs against that window", typeCall && typeCall.argv.includes("999001") && typeCall.argv.includes("hello world"));

// Inline plans are still allowed, and aliases apply to them as well.
calls.length = 0;
const inline = await run({ action: "run", profile: "notepad", plan: "invoke {{box}} Greetings" });
check("aliases resolve inside an inline plan", inline.text.includes("invoke 0.1.1"), inline.text.replace(/\n/g, " | "));
const invokeCall = calls.find((c) => c.argv[0] === "invoke");
check("the resolved alias reaches the engine", invokeCall && invokeCall.argv.join(" ").includes("--path 0.1.1 --value Greetings"), invokeCall ? invokeCall.argv.join(" ") : "none");

check("an unknown profile is refused with the names", (await throws(() => run({ action: "run", profile: "ghost", task: "x" }), "configured profiles: notepad")).ok);
check("an unknown task is refused with the plans", (await throws(() => run({ action: "run", profile: "notepad", task: "ghost" }), "plans: hello, many")).ok);
check("a profile that matches no window explains why", (await (async () => {
  const other = await loadTool({ profiles: { ghost: { match: { process: "ghost.exe" }, plans: { p: "read" } } } });
  return throws(() => other.run({ action: "run", profile: "ghost" }), "matches no open window");
})()).ok);

// Mutating the stub between cases must not leak into other tests.
state.typeVerify = null;

console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
