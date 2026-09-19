#!/usr/bin/env node
/**
 * Renders Atlas's selectable macOS app icons from their Icon Composer sources.
 *
 *   node scripts/app-icons.mjs            re-render everything (needs Xcode 26+)
 *   node scripts/app-icons.mjs --check    fail if a committed output is stale
 *
 * Source of truth: `src-tauri/icons/app-icons/app-icons.json` (ids, labels,
 * default) plus one `sources/<id>.icon` per id. Outputs, all committed:
 *
 *   app-icons/Assets.car        the DEFAULT icon, compiled by actool. Listed in
 *                               `bundle.icon`; Tauri copies a `.car` into the
 *                               bundle as-is, so builds never run actool.
 *   app-icons/dock/<id>.icns    every OTHER icon, rendered flat by ictool. A
 *                               bundled resource (tauri.macos.conf.json) that
 *                               `src-tauri/src/app_icon.rs` applies at runtime.
 *   app-icons/sources.sha256    hash of the default id + every source file, so
 *                               `--check` can tell an edited source from a
 *                               re-rendered one without Xcode.
 *
 * Why `Assets.car` is precompiled instead of listing the `.icon` in
 * `bundle.icon`: tauri-cli runs inside Node, which marks inherited descriptors
 * close-on-exec, so Tauri starts actool with stdin closed; actool's `ibtoold`
 * helper then fails with "Bad file descriptor" and the bundle aborts with
 * `Failed to create app Assets.car: failed to run actool` — after a full
 * release compile. Worse, the helper it leaves behind breaks later actool runs
 * too. Upstream: https://github.com/tauri-apps/tauri/issues/15315, fix in
 * https://github.com/tauri-apps/tauri/pull/15991. Once that ships, the default
 * `.icon` can go back into `bundle.icon` and `Assets.car` can be deleted.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ICONS_DIR = path.join(REPO_ROOT, "src-tauri", "icons", "app-icons");
const COMMAND = "bun run icons:render";

/** @returns {{ default: string, icons: { id: string, label: string }[] }} */
export function readManifest() {
  return JSON.parse(readFileSync(path.join(ICONS_DIR, "app-icons.json"), "utf8"));
}

/** Every file under `dir`, relative to it, sorted; Finder litter skipped. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * sha256 over the default id and every source file's path and bytes. The
 * labels are left out on purpose: renaming one in Settings needs no re-render.
 */
export function sourcesHash(manifest = readManifest()) {
  const hash = createHash("sha256");
  hash.update(`default:${manifest.default}\n`);
  const sources = path.join(ICONS_DIR, "sources");
  for (const rel of listFiles(sources)) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(path.join(sources, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** What `--check` would complain about; empty when every output is current. */
export function staleOutputs(manifest = readManifest()) {
  const problems = [];
  if (!existsSync(path.join(ICONS_DIR, "Assets.car"))) problems.push("Assets.car is missing");
  for (const { id } of manifest.icons) {
    if (id !== manifest.default && !existsSync(path.join(ICONS_DIR, "dock", `${id}.icns`))) {
      problems.push(`dock/${id}.icns is missing`);
    }
  }
  const stampPath = path.join(ICONS_DIR, "sources.sha256");
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  if (stamp !== sourcesHash(manifest)) {
    problems.push("sources changed since the last render (sources.sha256 does not match)");
  }
  return problems;
}

function run(cmd, args, env) {
  // stdin from /dev/null, never inherited — the whole reason this script exists.
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${path.basename(cmd)} failed (${r.status ?? r.signal}):\n${r.stdout}${r.stderr}`,
    );
  }
  return r.stdout;
}

/** The developer dir of an Xcode 26+, even when xcode-select names the CLT. */
function xcodeDeveloperDir() {
  const candidates = [process.env.DEVELOPER_DIR, run("xcode-select", ["-p"]).trim()];
  for (const app of [
    "Xcode.app",
    ...readdirSync("/Applications").filter((n) => /^Xcode.+\.app$/.test(n)),
  ]) {
    candidates.push(`/Applications/${app}/Contents/Developer`);
  }
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, "usr/bin/actool")) && existsSync(ictoolIn(dir)))
      return dir;
  }
  throw new Error(
    "needs Xcode 26+ (actool and Icon Composer's ictool); none found in /Applications",
  );
}

function ictoolIn(developerDir) {
  return path.join(
    developerDir,
    "..",
    "Applications",
    "Icon Composer.app",
    "Contents",
    "Executables",
    "ictool",
  );
}

function minimumSystemVersion() {
  const conf = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  return conf.bundle?.macOS?.minimumSystemVersion ?? "11.0";
}

/**
 * The default icon, compiled the way tauri-bundler compiles a `.icon`: copied
 * to `Icon.icon` so the icon is named "Icon", which matches `Icon.icns` — the
 * CFBundleIconFile fallback for macOS before 26.
 */
function compileAssetsCar(id, env, tmp) {
  const input = path.join(tmp, "Icon.icon");
  const out = path.join(tmp, "car");
  cpSync(path.join(ICONS_DIR, "sources", `${id}.icon`), input, { recursive: true });
  mkdirSync(out);
  // actool via DEVELOPER_DIR: `/usr/bin/actool` resolves through it.
  run(
    "/usr/bin/actool",
    [
      input,
      "--compile",
      out,
      "--output-format",
      "human-readable-text",
      "--errors",
      "--warnings",
      "--output-partial-info-plist",
      path.join(tmp, "partial.plist"),
      "--app-icon",
      "Icon",
      "--include-all-app-icons",
      "--enable-on-demand-resources",
      "NO",
      "--development-region",
      "en",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      minimumSystemVersion(),
      "--platform",
      "macosx",
    ],
    env,
  );
  cpSync(path.join(out, "Assets.car"), path.join(ICONS_DIR, "Assets.car"));
}

/**
 * A non-default icon as a flat `.icns`. ictool renders edge to edge, but macOS
 * icons sit on Apple's grid — an 824pt body centred in a 1024pt canvas, the
 * inset actool gives its own `.icns` — so render at 824 and pad to 1024.
 */
function renderIcns(id, developerDir, tmp) {
  const work = path.join(tmp, id);
  const iconset = path.join(work, `${id}.iconset`);
  mkdirSync(iconset, { recursive: true });
  const body = path.join(work, "body.png");
  const full = path.join(work, "1024.png");
  run(ictoolIn(developerDir), [
    path.join(ICONS_DIR, "sources", `${id}.icon`),
    "--export-image",
    "--output-file",
    body,
    "--platform",
    "macOS",
    "--rendition",
    "Default",
    "--width",
    "412",
    "--height",
    "412",
    "--scale",
    "2",
  ]);
  run("sips", ["--padToHeightWidth", "1024", "1024", body, "--out", full]);
  for (const size of [16, 32, 128, 256, 512]) {
    run("sips", [
      "-z",
      `${size}`,
      `${size}`,
      full,
      "--out",
      path.join(iconset, `icon_${size}x${size}.png`),
    ]);
    const double = size * 2;
    run("sips", [
      "-z",
      `${double}`,
      `${double}`,
      full,
      "--out",
      path.join(iconset, `icon_${size}x${size}@2x.png`),
    ]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", path.join(ICONS_DIR, "dock", `${id}.icns`)]);
}

function render() {
  const manifest = readManifest();
  const ids = manifest.icons.map((i) => i.id);
  if (!ids.includes(manifest.default))
    throw new Error(`default "${manifest.default}" is not in icons`);
  const developerDir = xcodeDeveloperDir();
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  const tmp = mkdtempSync(path.join(tmpdir(), "atlas-app-icons-"));
  try {
    compileAssetsCar(manifest.default, env, tmp);
    console.log(`app-icons: Assets.car ← sources/${manifest.default}.icon`);
    const dock = path.join(ICONS_DIR, "dock");
    mkdirSync(dock, { recursive: true });
    for (const name of readdirSync(dock)) {
      if (
        !ids.includes(path.basename(name, ".icns")) ||
        path.basename(name, ".icns") === manifest.default
      ) {
        rmSync(path.join(dock, name));
        console.log(`app-icons: removed dock/${name}`);
      }
    }
    for (const id of ids) {
      if (id === manifest.default) continue;
      renderIcns(id, developerDir, tmp);
      console.log(`app-icons: dock/${id}.icns ← sources/${id}.icon`);
    }
    writeFileSync(path.join(ICONS_DIR, "sources.sha256"), `${sourcesHash(manifest)}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function check() {
  const problems = staleOutputs();
  if (problems.length === 0) return;
  for (const p of problems) console.error(`app-icons: ${p}`);
  console.error(`app-icons: run \`${COMMAND}\` (needs Xcode 26+) and commit the result`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv.includes("--check")) check();
    else render();
  } catch (error) {
    console.error(`app-icons: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
