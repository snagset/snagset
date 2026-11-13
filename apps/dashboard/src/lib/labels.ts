/**
 * The words, once — and the same words as the widget's catalogue, so the two
 * surfaces never disagree about a state (settles `review` as "In review":
 * it names the STATE, and reads correctly to a client who does not know the
 * studio's process).
 */
export type Status = "open" | "progress" | "review" | "resolved";

export const STATUSES: readonly Status[] = ["open", "progress", "review", "resolved"];

export const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  progress: "In progress",
  review: "In review",
  resolved: "Resolved",
};

/**
 * The status as a FILL with its ink — the same object as the pin and the
 * dock's numbered circle. Never the status colour as text on
 * the page's ground: Pastel's amber on cream is 2:1.
 */
export const STATUS_COLOR: Record<Status, string> = {
  open: "bg-status-open text-white",
  progress: "bg-status-progress text-[#16161a]",
  review: "bg-status-review text-white",
  resolved: "bg-status-resolved text-[#16161a]",
};

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

/** "2 h", "3 d", "just now" — the list's age column. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "EF" from "Edith Finch"; the email's first letter when there is no name. */
export function initials(name: string, email = ""): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  if (parts.length === 1 && parts[0]!.length > 0) return parts[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}
