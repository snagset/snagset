import { briefMarkdown as shared, type BriefSite } from "@snagset/types/brief";
import type { Thread } from "./api";
import { STATUS_LABEL, isStatus } from "./labels.ts";

/**
 * The brief — ONE formatter, in the shared package, so the Copy
 * button, the MCP server's `get_thread` and the server's `…/threads/:id.md`
 * cannot drift. This wrapper only supplies the dashboard's status words; the
 * clipboard is the studio's own, so nothing is fenced.
 */
export type { BriefSite };

export function briefMarkdown(t: Thread, site: BriefSite): string {
  return shared(t, site, { statusLabel: (s) => (isStatus(s) ? STATUS_LABEL[s] : s) });
}
