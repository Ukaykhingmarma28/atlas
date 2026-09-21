// Build-mode flags injected by Vite. Resolved at build time — the unused
// branch in `if (isDev) { … }` is dead-code-eliminated from production
// bundles, so checks here cost zero runtime bytes.
//
// `bunx tauri dev`       → vite dev server, DEV=true, PROD=false
// `bun run build:app`    → vite production build, DEV=false, PROD=true
//
// The Rust side has the matching constant `cfg!(debug_assertions)`. The
// two are always in lock-step because Tauri compiles Rust in debug mode
// when serving from the Vite dev server and in release mode for bundled
// `.app`s.

export const isDev: boolean = import.meta.env.DEV;

/**
 * True only under `bun run dev` in an ordinary browser — the fake backend in
 * `src/dev/mock-backend/`, no Tauri shell.
 *
 * `isDev` alone also matches `bun run dev:app`, which IS a Tauri window; Tauri
 * sets `isTauri` on the global before any app module evaluates, which is the
 * same signal the mock installer itself uses to stand down. Together they name
 * the one session where native surfaces cannot exist.
 *
 * What it is for: decision 39's native-only placeholders. A surface that is a
 * native `WebviewWindow`, a Finder drop target or macOS window chrome has no
 * `invoke()` to fake, so it must SAY it is native rather than quietly drawing
 * something that looks finished. `import.meta.env.DEV` is a build-time literal,
 * so those branches are dead-code-eliminated from production.
 */
export const isBrowserMock: boolean = isDev && !(globalThis as { isTauri?: boolean }).isTauri;
