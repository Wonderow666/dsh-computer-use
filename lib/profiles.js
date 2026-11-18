import fs from "node:fs";
import path from "node:path";

// Per-application knowledge, declared instead of scripted.
//
// A throwaway script (pt.mjs, seq.mjs, g.mjs ...) encodes three things: which
// window it means, what the controls are called, and the sequence of steps that
// worked. All three are data. Keeping them in a profile means switching to a new
// app costs a JSON block, not a new program - and the same profile is what the
// model reads back through `profiles` / `state` instead of rediscovering it.
//
// Shape (all keys optional except `id`):
//
//   profiles:
//     pt:
//       match: { process: "PacketTracer.exe", class: "Qt51516QWindowIcon" }
//       notes: "palette sits at y=1404; workspace list is the reliable source"
//       aliases: { list: "0.1", addLink: "0.2.2" }
//       plans:
//         open: |
//           key ctrl+shift+l
//           wait /工作区列表/ 4000
//
// The object form above and an array of `{ id, ... }` objects are both accepted.

const MATCH_KEYS = ["hwnd", "process", "class", "title"];

function asText(v) {
  return v === undefined || v === null ? "" : String(v);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function one(key, expected, actual) {
  const want = asText(expected).trim();
  if (!want) return true;
  const got = asText(actual).trim();
  if (!got) return false;
  if (key === "hwnd") return want === got;
  if (key === "title") {
    // A window title is usually a sentence with state in it ("* report.docx -
    // Word"), so a substring would lie in both directions. Treat it as a regex
    // and fall back to a case-insensitive substring when it is not valid.
    try {
      return new RegExp(want, "i").test(got);
    } catch {
      return got.toLowerCase().includes(want.toLowerCase());
    }
  }
  if (want.includes("*") || want.includes("?")) {
    try {
      return globToRegExp(want).test(got);
    } catch {
      return want.toLowerCase() === got.toLowerCase();
    }
  }
  return want.toLowerCase() === got.toLowerCase();
}

/** A window matches when every key present in `match` matches. */
export function windowMatches(match, win) {
  const m = match || {};
  const w = win || {};
  if (!MATCH_KEYS.some((k) => asText(m[k]).trim())) return false;
  return MATCH_KEYS.every((k) => one(k, m[k], w[k]));
}

function planText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((l) => String(l)).join("\n");
  if (typeof value === "object") throw new Error(`plan must be text or a list of lines, got ${typeof value}`);
  return String(value);
}

/**
 * Accepts `{ id: def }` or `[{ id, ... }]` and returns a normalized list.
 * Throws on anything ambiguous - a silently ignored profile is worse than an
 * error, because the caller then debugs the wrong app.
 */
export function normalizeProfiles(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const defs = [];
  if (Array.isArray(raw)) {
    raw.forEach((def, i) => {
      if (!def || typeof def !== "object") throw new Error(`profiles[${i}] must be an object`);
      const id = def.id || def.name;
      if (!id) throw new Error(`profiles[${i}] needs an "id"`);
      defs.push({ id: String(id), def });
    });
  } else if (typeof raw === "object") {
    for (const [id, def] of Object.entries(raw)) {
      if (!def || typeof def !== "object") throw new Error(`profiles.${id} must be an object`);
      defs.push({ id: String(def.id || id), def });
    }
  } else {
    throw new Error("profiles must be an object map or an array");
  }

  const seen = new Set();
  return defs.map(({ id, def }) => {
    if (seen.has(id)) throw new Error(`profile "${id}" is declared twice`);
    seen.add(id);
    const plans = {};
    for (const [name, body] of Object.entries(def.plans || {})) {
      const text = planText(body);
      if (!text.trim()) throw new Error(`profile "${id}" plan "${name}" is empty`);
      plans[String(name)] = text;
    }
    const aliases = {};
    for (const [name, value] of Object.entries(def.aliases || {})) {
      aliases[String(name)] = String(value);
    }
    return {
      id,
      match: def.match && typeof def.match === "object" ? def.match : {},
      notes: def.notes ? String(def.notes) : "",
      aliases,
      plans
    };
  });
}

/**
 * Turn a raw `profiles` config value (map or array) into [{id, def}] pairs
 * without validating the bodies yet, so files and inline config can be merged.
 */
function rawDefs(raw, label) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map((def, i) => {
      const id = def && (def.id || def.name);
      if (!id) throw new Error(`${label}[${i}] needs an "id"`);
      return { id: String(id), def };
    });
  }
  if (typeof raw === "object") {
    return Object.entries(raw).map(([id, def]) => {
      if (!def || typeof def !== "object") throw new Error(`${label}.${id} must be an object`);
      return { id: String(def.id || id), def };
    });
  }
  throw new Error(`${label} must be an object map or an array`);
}

/**
 * Read profile definitions out of JSON files and/or directories of JSON files.
 * Each file may hold an array of profiles, a `{ profiles: ... }` wrapper, or a
 * plain `{id: definition}` map - whichever shape you copied out of a config.
 */
export function readProfileFiles(specs) {
  const out = [];
  for (const spec of [].concat(specs || [])) {
    if (!spec) continue;
    const abs = path.resolve(String(spec));
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      throw new Error(`profilesFile: cannot read "${spec}": ${e.message}`);
    }
    const files = stat.isDirectory()
      ? fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".json")).sort().map((f) => path.join(abs, f))
      : [abs];
    for (const file of files) {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        throw new Error(`profilesFile: ${file} is not valid JSON: ${e.message}`);
      }
      const body = data && typeof data === "object" && !Array.isArray(data) && data.profiles !== undefined ? data.profiles : data;
      for (const entry of rawDefs(body, path.basename(file))) out.push(entry);
    }
  }
  return out;
}

/**
 * Merge profile definitions: files first, inline config last, so an inline
 * definition can deliberately override a shipped example with the same id.
 */
export function mergeProfileLists(fileDefs, inlineRaw) {
  const byId = new Map();
  for (const entry of fileDefs || []) byId.set(entry.id, entry);
  for (const entry of rawDefs(inlineRaw, "profiles")) byId.set(entry.id, entry);
  return [...byId.values()].map(({ id, def }) => ({ ...def, id }));
}

/** Compact listing for the `profiles` action: no plan bodies, no aliases. */
export function describeProfiles(list) {
  return (list || []).map((p) => ({
    id: p.id,
    match: p.match,
    plans: Object.keys(p.plans),
    aliases: Object.keys(p.aliases),
    ...(p.notes ? { notes: p.notes } : {})
  }));
}

export function findProfile(list, id) {
  const want = asText(id).trim();
  if (!want) return null;
  const hit = (list || []).find((p) => p.id === want || p.id.toLowerCase() === want.toLowerCase());
  if (!hit) {
    const names = (list || []).map((p) => p.id);
    throw new Error(
      names.length
        ? `unknown profile ${JSON.stringify(want)}; configured profiles: ${names.join(", ")}`
        : `no profiles are configured; add a \`profiles\` block to the plugin config (see README)`
    );
  }
  return hit;
}

export function matchProfile(list, win) {
  for (const p of list || []) {
    if (windowMatches(p.match, win)) return p;
  }
  return null;
}

/** Plan body by name; a profile with exactly one plan may omit the name. */
export function planSource(profile, name) {
  if (!profile) throw new Error("planSource needs a profile");
  const names = Object.keys(profile.plans || {});
  const want = asText(name).trim();
  if (!want) {
    if (names.length === 1) return profile.plans[names[0]];
    if (!names.length) throw new Error(`profile "${profile.id}" has no plans`);
    throw new Error(`profile "${profile.id}" has ${names.length} plans; name one of: ${names.join(", ")}`);
  }
  const body = profile.plans[want];
  if (body === undefined) {
    throw new Error(
      names.length
        ? `profile "${profile.id}" has no plan ${JSON.stringify(want)}; plans: ${names.join(", ")}`
        : `profile "${profile.id}" has no plans`
    );
  }
  return body;
}

/** Replace `{{alias}}` placeholders; an unknown one is an error, not a guess. */
export function substitute(text, aliases) {
  const table = aliases || {};
  return String(text || "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    const known = Object.keys(table);
    throw new Error(
      known.length
        ? `unknown alias {{${name}}}; this profile defines: ${known.join(", ")}`
        : `unknown alias {{${name}}}; this profile defines no aliases`
    );
  });
}

/** Apply aliases to a parsed plan (only the argument part can hold them). */
export function applyAliasesToSteps(steps, aliases) {
  return (steps || []).map((s) => ({ ...s, rest: substitute(s.rest, aliases) }));
}
