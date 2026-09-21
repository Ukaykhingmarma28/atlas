// Host OS, sniffed once from the webview's user agent. Atlas ships no
// `@tauri-apps/plugin-os` (see the plugin selection in src-tauri/Cargo.toml),
// and the UA is exact enough for what this answers: which window chrome and
// platform conventions to render. WKWebView reports "Macintosh", WebView2
// "Windows NT", WebKitGTK on Linux reports "Linux".

const ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isMac: boolean = ua.includes("Macintosh");
export const isWindows: boolean = ua.includes("Windows");
export const isLinux: boolean = ua.includes("Linux");
