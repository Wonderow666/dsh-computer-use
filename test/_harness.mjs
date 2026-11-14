// Shared plumbing for the integration scripts: load the plugin exactly the way
// the DSH profile does (apply() with a minimal tools registry) and drive the
// real engine binary.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE = path.join(ROOT, "bin", "cu.exe");
export const ARTIFACTS = path.join(ROOT, "artifacts");

export async function loadTool(config = {}) {
  const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
  const defs = [];
  mod.apply({ tools: { register: (def) => defs.push(def) } }, {
    enabled: true,
    enginePath: ENGINE,
    artifactsDir: path.join(ARTIFACTS, "e2e"),
    timeoutMs: 30000,
    ...config,
  });
  const tool = defs[0];
  // Most actions answer with a JSON blob; `run` intentionally answers with a
  // plain-text transcript (that is the whole point of it), so fall back to the
  // raw string instead of pretending everything is JSON.
  const run = async (args) => {
    const text = (await tool.execute(args, {})).text;
    try { return JSON.parse(text); } catch { return { text }; }
  };
  return { mod, tool, run };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
