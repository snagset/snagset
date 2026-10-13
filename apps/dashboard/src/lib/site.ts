import { useParams } from "@tanstack/react-router";
import type { Me } from "./api";

/**
 * Which site the sidebar's Site group shows when the URL names none — Sites,
 * Studio and You are studio-level screens, and the group should keep showing
 * the site you were just in rather than going blank. Dashboard-local, like the
 * theme key.
 */
const LAST_SITE_KEY = "snagset:last-site";

export function rememberSite(uid: string): void {
  try {
    localStorage.setItem(LAST_SITE_KEY, uid);
  } catch {
    /* not remembered; the group falls back to the first site */
  }
}

export function lastSite(): string | null {
  try {
    return localStorage.getItem(LAST_SITE_KEY);
  } catch {
    return null;
  }
}

export type Site = Me["projects"][number];

/** The site in the URL, else the remembered one, else the first — or null on an empty studio. */
export function useCurrentSite(me: Me): Site | null {
  const params = useParams({ strict: false }) as { site?: string };
  const byUrl = params.site ? me.projects.find((p) => p.uid === params.site) : undefined;
  if (byUrl) return byUrl;
  const remembered = lastSite();
  return me.projects.find((p) => p.uid === remembered) ?? me.projects[0] ?? null;
}
