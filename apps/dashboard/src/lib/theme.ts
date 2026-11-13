/**
 * System / Dark / Light — the viewer's choice, kept in this browser.
 *
 * Three states, not two. "System" means the OS decides, live: a `matchMedia`
 * listener flips the page when the OS does. An explicit choice wins in BOTH
 * directions — a Light choice beats a dark OS and a Dark choice beats a light
 * one.
 *
 * Tailwind's `dark:` variant is keyed on a `.dark` class on <html> (the
 * shadcn convention, `@custom-variant dark` in index.css), so this module
 * RESOLVES the three-state choice into that one class. `data-theme` is set
 * alongside for anything that wants the raw choice — and for the pre-paint
 * script in index.html, which repeats the same resolution before any module
 * can be imported, so a dark-preferring viewer who chose Light never sees a
 * dark frame and then a flip.
 *
 * The key is DASHBOARD-LOCAL and deliberately not in the names registry: the
 * dashboard is its own origin, this value never reaches the widget or the
 * client's page, and the registry exists to pin names that cross a package
 * boundary. If a second consumer ever appears it moves there.
 */
export type Theme = "system" | "dark" | "light";

export const THEME_KEY = "snagset:theme";

const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    // Private windows and locked-down browsers throw on the accessor itself.
    return "system";
  }
}

/** The class the stylesheet keys on, from the choice and the OS. */
export function resolveTheme(t: Theme): "dark" | "light" {
  if (t !== "system") return t;
  return media()?.matches ? "dark" : "light";
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
  const dark = resolveTheme(t) === "dark";
  el.classList.toggle("dark", dark);
  el.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* the choice still applies for this page; it just will not be remembered */
  }
  applyTheme(t);
}

/**
 * Follow the OS while the choice is "system". Called once at boot; the
 * listener re-reads the choice on every change so a later explicit choice
 * is never overridden by the OS flipping.
 */
export function watchSystemTheme(): () => void {
  const m = media();
  if (!m) return () => {};
  const onChange = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
