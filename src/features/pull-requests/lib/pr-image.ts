// Images in pull-request bodies and comments, as object URLs.
//
// The webview may not load a remote image (CSP `img-src` stays closed), and
// a private repository's attachment needs the user's credential anyway, so
// the bytes come from the native proxy (`pr_image`) and are handed to an
// `<img>` as a `blob:` URL. One URL per image address, shared by every
// renderer; the oldest are revoked past a bound so a long session does not
// hold every screenshot it ever showed.

import { useEffect, useState } from "react";

import { prImage } from "./pull-requests-api";

/** Hosts the native proxy fetches; anything else is not asked for at all. */
const IMAGE_HOSTS = new Set([
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "avatars.githubusercontent.com",
]);

/** Whether `url` is an image the proxy will fetch — mirrors the native
 *  allowlist, so a refused URL costs no IPC round trip. */
export function isProxiedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  if (parsed.hostname === "github.com")
    return parsed.pathname.startsWith("/user-attachments/assets/");
  return IMAGE_HOSTS.has(parsed.hostname);
}

export const IMAGE_CACHE_CAPACITY = 64;

/** Address → object URL, oldest first; and the reads still in flight. */
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function remember(address: string, objectUrl: string): void {
  urls.set(address, objectUrl);
  while (urls.size > IMAGE_CACHE_CAPACITY) {
    const [oldest, url] = urls.entries().next().value as [string, string];
    urls.delete(oldest);
    URL.revokeObjectURL(url);
  }
}

/** An object URL for the image at `address`, fetched through the checkout's
 *  `gh` login. Rejects for an address the proxy will not fetch. */
export function loadPrImage(cwd: string, address: string): Promise<string> {
  const held = urls.get(address);
  if (held) {
    urls.delete(address);
    urls.set(address, held);
    return Promise.resolve(held);
  }
  const inFlight = pending.get(address);
  if (inFlight) return inFlight;
  if (!isProxiedImageUrl(address)) {
    return Promise.reject(new Error("Only GitHub's own images are shown."));
  }
  const read = prImage(cwd, address)
    .then((image) => {
      const objectUrl = URL.createObjectURL(
        new Blob([decode(image.data)], { type: image.contentType }),
      );
      remember(address, objectUrl);
      return objectUrl;
    })
    .finally(() => pending.delete(address));
  pending.set(address, read);
  return read;
}

/** The object URL for an image, or `null` while it loads or if it cannot. */
export function usePrImage(cwd: string | null, address: string | null): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    address ? (urls.get(address) ?? null) : null,
  );
  useEffect(() => {
    if (!cwd || !address) {
      setSrc(null);
      return;
    }
    let live = true;
    loadPrImage(cwd, address).then(
      (url) => live && setSrc(url),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [cwd, address]);
  return src;
}

/** Test seam: forget (and revoke) every image. */
export function resetPrImagesForTests(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  pending.clear();
}
