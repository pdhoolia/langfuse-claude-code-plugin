import { build } from "esbuild";
import { chmodSync } from "node:fs";

const hookEntries = [
  "dist/hooks/user-prompt-submit.js",
  "dist/hooks/pre-tool-use.js",
  "dist/hooks/post-tool-use.js",
  "dist/hooks/stop.js",
  "dist/hooks/stop-failure.js",
  "dist/hooks/subagent-stop.js",
  "dist/hooks/pre-compact.js",
  "dist/hooks/post-compact.js",
  "dist/hooks/session-end.js",
];

const commandEntries = ["dist/commands/feedback.js", "dist/commands/journey.js"];

await build({
  entryPoints: [...hookEntries, ...commandEntries],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  // Preserves dist/hooks → bundle/hooks and dist/commands → bundle/commands.
  // ADR-companion to commands feature; see EIS §3.12 and §9 for migration.
  outbase: "dist",
  // Mark node builtins as external (they're available at runtime)
  external: ["node:*"],
});

// Make bundles executable.
for (const entry of [...hookEntries, ...commandEntries]) {
  // "dist/hooks/stop.js" → "bundle/hooks/stop.js"
  const bundlePath = entry.replace(/^dist\//, "bundle/");
  chmodSync(bundlePath, 0o755);
}

console.log(`Bundled ${hookEntries.length} hooks + ${commandEntries.length} commands into bundle/`);
