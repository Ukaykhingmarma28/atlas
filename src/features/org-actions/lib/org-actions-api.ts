/** The IPC surface of organisation calls: the one audit event. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { OrgActionRecord } from "./types";

export function listenOrgAction(handler: (record: OrgActionRecord) => void): Promise<UnlistenFn> {
  return listen<OrgActionRecord>("atlas:org-action", (event) => handler(event.payload));
}
