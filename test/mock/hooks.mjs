// Test doubles for the dsh-computer-use plugin. Registered through
// module.register() so the plugin source runs unmodified while its two
// @deepseek-ai dependencies and node:child_process are replaced.
//
// Why: the DSH sandbox forbids piped stdio in spawned children (EPERM), so a
// real spawn from inside the sandbox cannot be exercised. The engine itself is
// covered by direct cu.exe invocations; here we assert the *plugin contract*
// - argv mapping, window resolution, safety guard, dryRun, text spooling.
export async function resolve(specifier, context, next) {
  const map = {
    "@deepseek-ai/dsh-tools": "./stub-tools.mjs",
    "@deepseek-ai/schemastery": "./stub-schemastery.mjs",
    "node:child_process": "./stub-cp.mjs"
  };
  if (map[specifier]) return { url: new URL(map[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
