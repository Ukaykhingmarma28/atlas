import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { useGitStore } from "../stores/git-store";
import { useGithubAvatars } from "../lib/git-avatars-api";

// Module-level cache so we don't recompute the same hash repeatedly while
// scrolling through the virtualized list.
const hashCache = new Map<string, string>();

async function sha256(text: string): Promise<string> {
  const cached = hashCache.get(text);
  if (cached) return cached;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = Array.from(new Uint8Array(buf));
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  hashCache.set(text, hex);
  return hex;
}

/** GitHub's private-email form `<id>+<login>@users.noreply.github.com` names
 *  the account outright — no lookup needed. */
const NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/;

function withSize(url: string, px: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
}

interface CommitAvatarProps {
  email: string | null | undefined;
  /** The repository the commit belongs to; defaults to the active one. */
  repoPath?: string;
  size?: number;
  className?: string;
}

/**
 * A commit author's face: their GitHub avatar when GitHub knows the email,
 * else Gravatar, else a generic glyph. Each source that fails to load falls
 * through to the next.
 */
export function CommitAvatar({ email, repoPath, size = 16, className }: CommitAvatarProps) {
  const key = email?.trim().toLowerCase() ?? "";
  const [hash, setHash] = useState<string | null>(() =>
    key ? (hashCache.get(key) ?? null) : null,
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const activeRepo = useGitStore.use.repoPath();
  const byEmail = useGithubAvatars(repoPath ?? activeRepo ?? "");

  useEffect(() => {
    let cancelled = false;
    setFailed(new Set());
    if (!key) {
      setHash(null);
      return;
    }
    if (hashCache.has(key)) {
      setHash(hashCache.get(key)!);
      return;
    }
    sha256(key).then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const noreplyId = key.match(NOREPLY)?.[1];
  const github =
    (key && byEmail?.[key]) ||
    (noreplyId ? `https://avatars.githubusercontent.com/u/${noreplyId}?v=4` : null);
  const src = [
    github ? withSize(github, size * 2) : null,
    hash ? `https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404` : null,
  ].find((url): url is string => !!url && !failed.has(url));

  return (
    <span
      className={`relative inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 bg-[var(--card)] border border-[var(--border)] ${
        className ?? ""
      }`}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed((prev) => new Set(prev).add(src))}
          className="w-full h-full object-cover"
        />
      ) : (
        <User
          size={Math.max(8, Math.floor(size * 0.55))}
          className="text-[var(--muted-foreground)]"
        />
      )}
    </span>
  );
}
