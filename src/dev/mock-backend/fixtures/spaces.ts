// Two boards that look alike and share nothing: the local canvas
// (`.atlas/canvas.json`, one JSON blob Rust reads and writes) and a realtime
// Space (a Yjs document Rust only shuttles, opaquely, over `atlas:spaces`).
//
// The local canvas is easy — `load_canvas` hands back a string, `save_canvas`
// takes one. It is kept in module state so an edit survives a tab switch: the
// store debounces a save 400ms after any mutation, and re-reads on the next
// `loadProject`, so without a writable fake every drag silently snaps back.
//
// The Space is the interesting half. `use-space-session.ts` drives a real
// protocol, and nothing renders until the whole handshake completes:
//
//   spaces_summary          REST pre-flight → the page tree
//   spaces_connect          → connection:open, then a `space.hello` frame
//   page.open (control)     → `page.opened` carrying a base64 Yjs snapshot
//   binary frame (awareness)→ the peers whose cursors and selections show
//
// So the snapshot here is built by running `space-doc`'s own writers over a
// real `Y.Doc` and encoding the state — not by hand-assembling CRDT bytes.
// That also means this fixture cannot drift from the document schema: if
// `addNode` changes, this file changes with it or stops compiling.
//
// What each seeded shape is for: every node kind the union offers (note, text,
// shape, media, group) so the renderers are all reachable; an EMPTY group and
// an empty page, because those are the states a board full of content hides; a
// node with a title far wider than its card; and a peer whose awareness claims
// a selection, which is the only way a node renders selected-by-somebody-else.

import { emit } from "@tauri-apps/api/event";
import * as Y from "yjs";
import { toBase64 } from "@/features/comms/lib/draft-sync";
import type { CanvasEdge, CanvasFile, CanvasNode } from "@/features/canvas/stores/canvas-store";
import { addEdge, addNode } from "@/features/spaces/lib/space-doc";
import {
  encodeSpaceAwarenessState,
  encodeSpaceFrame,
  SPACE_FRAME_AWARENESS,
  type SpaceAwarenessState,
} from "@/features/spaces/lib/space-wire";
import type {
  SpaceClientMessage,
  SpaceEnvelope,
  SpaceMediaUploaded,
  SpacePage,
  SpaceServerMessage,
  SpaceSummary,
} from "@/features/spaces/lib/spaces-api";
import type { TypedHandlers, Unit } from "../types";
import { abs, MOCK_ORG_ID, MOCK_PROJECT } from "../project";
import { mockAssetUrl } from "./files";

const ISO = "2026-09-18T09:14:00.000Z";

// ── the local canvas ──────────────────────────────────────────────────────

const note = (
  id: string,
  x: number,
  y: number,
  title: string,
  body: string,
  icon?: string,
): CanvasNode => ({
  id,
  kind: "note",
  x,
  y,
  width: 260,
  height: 150,
  title,
  body,
  ...(icon ? { icon } : {}),
  createdAt: ISO,
  updatedAt: ISO,
});

const CANVAS_NODES: CanvasNode[] = [
  note(
    "n_intake",
    -320,
    -180,
    "Intake service",
    "Validates the payload, stamps a request id, drops it on the queue.",
    "📥",
  ),
  note(
    "n_queue",
    40,
    -180,
    "Work queue",
    "Redis streams. At-least-once; the worker is the one that has to be idempotent.",
    "🧵",
  ),
  // The truncation case: a title nobody sized the card for.
  note(
    "n_long",
    400,
    -180,
    "Reconciliation worker that also owns the nightly ledger sweep and the retry ladder",
    "Runs every 15 minutes, and again at 02:00 for anything the ladder gave up on.",
    "🧮",
  ),
  {
    id: "n_caption",
    kind: "text",
    x: -320,
    y: 40,
    width: 300,
    height: 60,
    title: "",
    body: "",
    text: "Everything below the line is still a sketch — do not wire it yet.",
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: "n_decision",
    kind: "shape",
    shapeType: "diamond",
    x: 60,
    y: 60,
    width: 200,
    height: 140,
    title: "",
    body: "",
    text: "retryable?",
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: "n_shot",
    kind: "media",
    src: "media_seed_logo.png",
    mediaKind: "image",
    x: 420,
    y: 60,
    width: 320,
    height: 200,
    title: "",
    body: "",
    createdAt: ISO,
    updatedAt: ISO,
  },
];

const CANVAS_EDGES: CanvasEdge[] = [
  {
    id: "e_intake_queue",
    source: "n_intake",
    target: "n_queue",
    sourceHandle: "r",
    targetHandle: "l",
  },
  { id: "e_queue_long", source: "n_queue", target: "n_long", sourceHandle: "r", targetHandle: "l" },
  {
    id: "e_queue_decision",
    source: "n_queue",
    target: "n_decision",
    sourceHandle: "b",
    targetHandle: "t",
  },
  {
    id: "e_decision_long",
    source: "n_decision",
    target: "n_long",
    sourceHandle: "r",
    targetHandle: "b",
  },
];

function seedCanvas(): CanvasFile {
  return {
    version: 4,
    pages: [
      {
        id: "p_architecture",
        viewport: { x: 420, y: 300, zoom: 0.8 },
        nodes: CANVAS_NODES,
        edges: CANVAS_EDGES,
      },
      // The empty-board state, one click away instead of only on a fresh project.
      { id: "p_scratch", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
      {
        id: "p_retro",
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          note("n_kept", -160, -60, "Kept", "Version branches. The release is the merge."),
          note("n_dropped", 160, -60, "Dropped", "Trunk-based dev, twice."),
        ],
        edges: [],
      },
    ],
    tree: [
      {
        id: "p_architecture",
        kind: "page",
        parentId: null,
        name: "Architecture",
        icon: "🗺️",
        order: 0,
      },
      { id: "p_scratch", kind: "page", parentId: null, name: "Scratch", order: 1 },
      // A folder with nothing under it — the sidebar's empty-group state.
      { id: "f_archive", kind: "folder", parentId: null, name: "Archive", icon: "🗄️", order: 2 },
      { id: "f_2026", kind: "folder", parentId: null, name: "2026", order: 3 },
      { id: "p_retro", kind: "page", parentId: "f_2026", name: "Retro — 0.3.1", order: 0 },
    ],
    activePageId: "p_architecture",
  };
}

/** Per-project canvas JSON. Writes land here, so a node dragged on one tab is
 *  still where it was left after a tab switch (which re-reads the file). */
const canvasFiles = new Map<string, string>([[MOCK_PROJECT.path, JSON.stringify(seedCanvas())]]);

// ── the realtime Space ────────────────────────────────────────────────────

const PAGES: SpacePage[] = [
  {
    id: "sp_board",
    kind: "page",
    name: "Launch board",
    icon: "🚀",
    parent_id: null,
    sort: 0,
    created_at: Date.parse("2026-09-11T10:00:00Z"),
    updated_at: Date.parse("2026-09-18T09:14:00Z"),
  },
  {
    id: "sp_empty",
    kind: "page",
    name: "Notes from the call nobody has written up yet",
    icon: null,
    parent_id: null,
    sort: 1,
    created_at: Date.parse("2026-09-16T15:20:00Z"),
    updated_at: Date.parse("2026-09-16T15:20:00Z"),
  },
  {
    id: "sp_folder",
    kind: "folder",
    name: "Archive",
    icon: "🗄️",
    parent_id: null,
    sort: 2,
    created_at: Date.parse("2026-09-02T08:00:00Z"),
    updated_at: Date.parse("2026-09-02T08:00:00Z"),
  },
];

/** Node ids are referenced by the seeded edges AND by a peer's awareness
 *  selection, so they are fixed rather than generated. */
const SPACE_NODES = {
  brief: "sn_brief",
  long: "sn_long",
  caption: "sn_caption",
  gate: "sn_gate",
  shot: "sn_shot",
  group: "sn_group",
} as const;

/** The image a media node points at. `spaces_media_fetch` answers with the
 *  seeded PNG's path, which `convertFileSrc` (patched in `install.ts`) turns
 *  into a data URL — so the node renders a real picture. */
const MEDIA_HASH = "b3d4f6a1c27e9058113f4a6d82c0e57bb914d2c6f03a8e71d45c9ba2e6081f39";
const MEDIA_MIME = "image/png";

/** Build one page's document by running the real writers, then encode it the
 *  way the server would hand it over in `page.opened`. */
function snapshotFor(pageId: string): string | null {
  const doc = new Y.Doc();
  if (pageId === "sp_board") {
    addNode(doc, {
      id: SPACE_NODES.brief,
      kind: "note",
      x: -360,
      y: -200,
      width: 260,
      height: 160,
      title: "Ship 0.3.1",
      body: "Version branch cut. Everything below is what still has to land.",
    });
    addNode(doc, {
      id: SPACE_NODES.long,
      kind: "note",
      x: 40,
      y: -200,
      width: 260,
      height: 160,
      title:
        "Rewrite the theme pipeline so the shadcn base tokens and the derived keys stop disagreeing",
      body: "ADR-0009. Blocked on the diff view's four line backgrounds.",
    });
    addNode(doc, {
      id: SPACE_NODES.caption,
      kind: "text",
      x: -360,
      y: 20,
      width: 300,
      height: 60,
      text: "Anything in the dashed frame is next week's problem.",
    });
    addNode(doc, {
      id: SPACE_NODES.gate,
      kind: "shape",
      shapeType: "diamond",
      x: 60,
      y: 40,
      width: 200,
      height: 140,
      text: "cut RC?",
      color: "#f2b955",
    });
    addNode(doc, {
      id: SPACE_NODES.shot,
      kind: "media",
      x: 420,
      y: 20,
      width: 320,
      height: 200,
      mediaKind: "image",
      contentHash: MEDIA_HASH,
      mime: MEDIA_MIME,
    });
    // Deliberately empty: a group with nothing in it is a real thing to leave
    // on a board, and it is the only way to see the frame's own affordances.
    addNode(doc, {
      id: SPACE_NODES.group,
      kind: "group",
      x: -380,
      y: 240,
      width: 520,
      height: 280,
      title: "Next week",
    });
    addEdge(doc, { source: SPACE_NODES.brief, target: SPACE_NODES.long });
    addEdge(doc, {
      source: SPACE_NODES.brief,
      target: SPACE_NODES.gate,
      sourceAnchor: "s",
      targetAnchor: "w",
    });
    addEdge(doc, {
      source: SPACE_NODES.gate,
      target: SPACE_NODES.shot,
      text: "yes",
      color: "#4bd1a0",
    });
    return toBase64(Y.encodeStateAsUpdate(doc));
  }
  // `sp_empty` really is empty — an unwritten page has no snapshot at all,
  // and `applyPageContent` has to cope with that, not with empty bytes.
  return null;
}

/** Two people already on the board. The first claims a selection, which is
 *  what draws somebody else's colour around a node; the second is parked with
 *  no cursor, the "idle, still here" state. */
const PEERS: { actor: string; state: SpaceAwarenessState }[] = [
  {
    actor: "usr_priya",
    state: {
      name: "Priya Raman",
      cursor: { x: 120, y: -40 },
      selection: [SPACE_NODES.long],
      viewport: { x: 420, y: 300, zoom: 0.8 },
      following: null,
    },
  },
  {
    actor: "usr_sam",
    state: {
      name: "Sam Okafor",
      cursor: null,
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      following: null,
    },
  },
];

/**
 * The server's coalesced awareness fanout: `[u8 actorLen][actor][u32
 * stateLen][state]`, repeated. `frameAwareness` in `space-wire.ts` encodes one
 * BARE state for the outbound direction only — the inbound shape is stamped by
 * the server, so it is built here.
 */
function awarenessFanout(slot: number): Uint8Array {
  const encoder = new TextEncoder();
  const parts = PEERS.map((peer) => ({
    actor: encoder.encode(peer.actor),
    state: encodeSpaceAwarenessState(peer.state),
  }));
  const size = parts.reduce((sum, p) => sum + 1 + p.actor.length + 4 + p.state.length, 0);
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  let at = 0;
  for (const part of parts) {
    payload[at] = part.actor.length;
    at += 1;
    payload.set(part.actor, at);
    at += part.actor.length;
    view.setUint32(at, part.state.length);
    at += 4;
    payload.set(part.state, at);
    at += part.state.length;
  }
  return encodeSpaceFrame(SPACE_FRAME_AWARENESS, slot, payload);
}

/** Slots are handed out per conversation, as the server does — a page re-open
 *  gets a NEW one, and the session drops frames for the old one. */
const slots = new Map<string, number>();

function send(convId: string, ev: SpaceEnvelope["ev"]): void {
  void emit("atlas:spaces", { org: MOCK_ORG_ID, conv: convId, ev } satisfies SpaceEnvelope);
}

const control = (convId: string, message: SpaceServerMessage) =>
  send(convId, { kind: "control", frame: JSON.stringify(message) });

function summaryFor(convId: string): SpaceSummary {
  return {
    protocol: 1,
    doc_version: 1,
    space_id: `spc_${convId}`,
    conv_id: convId,
    pages: PAGES,
    active_page_id: "sp_board",
    archived: false,
  };
}

/** Dial: the two frames every session waits on, in the order a real socket
 *  delivers them. Delayed so the bus subscription (a separate effect) is up. */
function openSocket(convId: string): void {
  send(convId, { kind: "connection", state: "connecting" });
  setTimeout(() => {
    send(convId, { kind: "connection", state: "open" });
    control(convId, { t: "space.hello", ...summaryFor(convId) });
  }, 120);
}

function parseClientMessage(frame: string): SpaceClientMessage | null {
  try {
    return JSON.parse(frame) as SpaceClientMessage;
  } catch {
    return null;
  }
}

// ── handlers ──────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface SpacesResponses {
  load_canvas: string;
  save_canvas: Unit;
  canvas_media_upload: string;
  canvas_media_data_url: string;
  spaces_summary: SpaceSummary;
  spaces_connect: Unit;
  spaces_disconnect: Unit;
  spaces_cycle: Unit;
  spaces_send_control: Unit;
  spaces_send_binary: Unit;
  spaces_media_upload: SpaceMediaUploaded;
  spaces_media_fetch: string;
}

export const spacesHandlers: TypedHandlers<SpacesResponses> = {
  // ── local canvas (.atlas/canvas.json) ───────────────────────────────────
  load_canvas: ({ projectPath }): string =>
    canvasFiles.get(String(projectPath)) ??
    // What Rust returns when the file does not exist yet: a v2 empty board the
    // store migrates to v4. Another project's canvas really is empty.
    '{"version":2,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}',
  save_canvas: ({ projectPath, payload }): null => {
    canvasFiles.set(String(projectPath), String(payload));
    return null;
  },
  canvas_media_upload: ({ srcPath }): string => {
    const ext = String(srcPath).split(".").pop()?.toLowerCase() || "bin";
    return `media_${Date.now()}.${ext}`;
  },
  // Rust inlines the bytes because `.atlas/` is 403 to the asset protocol.
  // Any media name resolves to the one seeded binary; the seeded node's name
  // is what the board actually asks for.
  canvas_media_data_url: ({ src }): string => {
    const url = mockAssetUrl(abs("public/logo.png"), () => "");
    if (!url) throw new Error(`media not found: ${String(src)}`);
    return url;
  },

  // ── realtime Spaces ─────────────────────────────────────────────────────
  spaces_summary: ({ convId }): SpaceSummary => summaryFor(String(convId)),
  spaces_connect: ({ convId }): null => {
    openSocket(String(convId));
    return null;
  },
  spaces_disconnect: ({ convId }): null => {
    const conv = String(convId);
    slots.delete(conv);
    send(conv, { kind: "connection", state: "disconnected" });
    return null;
  },
  /** The server's `reconnect: true` instruction — drop and redial for a fresh
   *  slot. The session re-opens its page off the new `space.hello`. */
  spaces_cycle: ({ convId }): null => {
    const conv = String(convId);
    send(conv, { kind: "connection", state: "backoff" });
    setTimeout(() => openSocket(conv), 200);
    return null;
  },

  spaces_send_control: ({ convId, frame }): null => {
    const conv = String(convId);
    const message = parseClientMessage(String(frame));
    if (!message) return null;
    switch (message.t) {
      case "page.open": {
        const slot = (slots.get(conv) ?? -1) + 1;
        slots.set(conv, slot);
        setTimeout(() => {
          control(conv, {
            t: "page.opened",
            page_id: message.page_id,
            slot,
            resume: message.since !== undefined,
            snapshot: snapshotFor(message.page_id),
            index: 1,
            updates: [],
            read_only: null,
          });
          // Awareness is never replayed by the server; the peers announce
          // themselves right after the page is open, as they would.
          setTimeout(() => {
            send(conv, { kind: "binary", data: toBase64(awarenessFanout(slot)) });
          }, 150);
        }, 60);
        return null;
      }
      case "page.create":
      case "page.rename":
      case "page.move":
      case "page.delete":
        // Tree edits are non-optimistic: the client changes nothing until the
        // server broadcasts. This fixture's tree is fixed, so echoing it back
        // is the honest answer — the row snaps back, which is the real
        // behaviour of an edit the server refused.
        setTimeout(() => control(conv, { t: "page.tree", pages: PAGES }), 80);
        return null;
      case "page.active":
        return null;
    }
  },
  // Local edits are accepted and relayed nowhere — there is no second client.
  spaces_send_binary: (): null => null,

  spaces_media_upload: ({ path }): SpaceMediaUploaded => {
    const ext = String(path).split(".").pop()?.toLowerCase() ?? "";
    if (!["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm"].includes(ext)) {
      // The allowlist refusal, verbatim — SVG's absence from it is the XSS
      // defence, and a fixture that accepted everything would hide it.
      throw new Error("unsupported media type");
    }
    return {
      contentHash: MEDIA_HASH,
      mime: MEDIA_MIME,
      mediaKind: ext === "mp4" || ext === "webm" ? "video" : "image",
      bytes: 48_214,
    };
  },
  /** An absolute cache path; the node hands it to `convertFileSrc`. */
  spaces_media_fetch: ({ contentHash }): string => {
    if (String(contentHash) !== MEDIA_HASH) throw new Error("media bytes are not cached");
    return abs("public/logo.png");
  },
};
