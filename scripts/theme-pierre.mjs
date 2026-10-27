/**
 * Writes the Atlas theme's syntax colours from `@pierre/theme`, the palette
 * Pierre's diffs use.
 *
 * Each of Pierre's two VS Code themes goes through Atlas's own VS Code
 * importer (the `syntax_from_vscode` example in `crates/atlas-theme`), so the
 * scopes map onto Atlas's fifteen syntax roles exactly as they would for a
 * theme a user imports. The result replaces the marked block in each variant
 * of `crates/atlas-theme/themes/atlas.toml`, and becomes the last-resort
 * `dark`/`light` default of each `syntax.*` key in `keys.toml` — what a theme
 * that sets neither the key nor its palette or base source gets. The files
 * derived from those two (the mock's built-in snapshot, the `tokens.css`
 * floor, and everything `theme:keys` writes) are regenerated, and Pierre's
 * LICENSE and NOTICE are copied beside them.
 *
 * To take a new Pierre release: `bun update @pierre/theme`, then
 * `bun run theme:pierre`. `tests/pierre-syntax.test.ts` fails while the
 * installed version and the one the block names differ.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pierre = join(root, "node_modules", "@pierre", "theme");
const target = join(root, "crates", "atlas-theme", "themes", "atlas.toml");
const keysToml = join(root, "crates", "atlas-theme", "keys.toml");
const thirdParty = join(root, "crates", "atlas-theme", "third-party", "pierre-theme");

const { version } = JSON.parse(readFileSync(join(pierre, "package.json"), "utf8"));

/** The marker lines, shared with the test that checks them. */
export const begin = (variant) =>
  `# BEGIN syntax from @pierre/theme ${version} (pierre-${variant}), written by \`bun run theme:pierre\``;
export const END = "# END syntax from @pierre/theme";

function syntaxLines(variant) {
  return execFileSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "atlas-theme",
      "--example",
      "syntax_from_vscode",
      "--",
      join(pierre, "themes", `pierre-${variant}.json`),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
}

let toml = readFileSync(target, "utf8");
let keys = readFileSync(keysToml, "utf8");
for (const variant of ["dark", "light"]) {
  const lines = syntaxLines(variant);
  const block = new RegExp(
    `# BEGIN syntax from @pierre/theme [^\\n]*\\(pierre-${variant}\\)[^\\n]*\\n[\\s\\S]*?${END}`,
  );
  if (!block.test(toml)) throw new Error(`atlas.toml has no Pierre block for ${variant}`);
  toml = toml.replace(block, `${begin(variant)}\n${lines}\n${END}`);

  // `"syntax.keyword" = "#ff678d"` → that key's `dark = …` / `light = …`.
  for (const [, key, value] of lines.matchAll(/^"(syntax\.[a-z_]+)" = "([^"]+)"$/gm)) {
    const entry = new RegExp(
      `(name = "${key.replace(".", "\\.")}"\\n(?:(?!\\[\\[)[^\\n]*\\n)*?${variant} = )"[^"]*"`,
    );
    if (!entry.test(keys)) throw new Error(`keys.toml has no ${variant} default for ${key}`);
    keys = keys.replace(entry, `$1"${value}"`);
  }
}
writeFileSync(target, toml);
writeFileSync(keysToml, keys);
execFileSync("node", [join(root, "scripts", "generate-theme-keys.mjs")], {
  cwd: root,
  stdio: "inherit",
});

// The two copies derived from atlas.toml: the browser mock's snapshot of the
// built-in themes, and the Atlas-dark floor in `tokens.css`.
const builtins = execFileSync(
  "cargo",
  ["run", "-q", "-p", "atlas-theme", "--example", "generate_builtins"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
writeFileSync(join(root, "src/dev/mock-backend/fixtures/builtin-themes.json"), builtins);
execFileSync("bunx", ["vitest", "run", "src/features/theme/tokens-fallback.test.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ATLAS_WRITE_TOKENS: "1" },
});

mkdirSync(thirdParty, { recursive: true });
for (const file of ["LICENSE", "NOTICE.md"])
  copyFileSync(join(pierre, file), join(thirdParty, file));
console.log(`atlas.toml syntax now from @pierre/theme ${version}.`);
