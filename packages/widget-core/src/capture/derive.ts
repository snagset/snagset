import type { UaData } from "./types.ts";

/**
 * The display triple — browser, os, device.
 *
 * THE ACCURACY CONTRACT, and it is normative: "`derived` is
 * best-effort, display-only, and never branched on. It must not gate a
 * capability, filter a query, drive a redaction decision, or be compared for
 * equality anywhere. The single behavioural consumer permitted is the list
 * row's device icon." (c) is a CI grep for exactly that. The raw `ua`
 * string is stored verbatim alongside it and is the authoritative record;
 * nothing here is ever written back into it.
 *
 * Runs inside the ≤ 2 ms synchronous snapshot, so it is regex over one string
 * and nothing else.
 */
export function deriveDisplay(
  ua: string,
  uaData?: UaData,
): { browser: string; os: string; device: "Mobile" | "Desktop" } {
  // ORDER IS LOAD-BEARING, and it is the classic bug in this five-line
  // function: Edge and Opera both put "Chrome/" in their UA string, and
  // Chrome's contains "Safari/". Most specific first, always.
  let browser = "Unknown";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  let os = "";
  if (/Macintosh/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";

  // Client hints, where they exist, beat UA sniffing.
  if (uaData?.brands?.length) {
    const named = uaData.brands.find((b) => !/Not.?A.?Brand/i.test(b.brand));
    if (named) browser = named.brand;
  }
  if (uaData?.platform) os = uaData.platform;

  // DEVIATION .2b's listing, which calls matchMedia() unguarded
  // inside a ?? chain: in any environment without it — a test runner, an
  // embedded webview, jsdom — that THROWS and takes the entire CaptureContext
  // down with it. The failure table has a row for absent userAgentData and
  // none for absent matchMedia.
  let coarse = false;
  try {
    coarse = typeof matchMedia === "function" && matchMedia("(pointer:coarse)").matches;
  } catch {
    /* no matchMedia — fall back to the UA string below */
  }

  // Order of trust,: a touchscreen laptop reports a coarse pointer and
  // would be called Mobile by pointer alone, so the client hint is consulted
  // FIRST and the pointer only decides when there is no hint.
  const device: "Mobile" | "Desktop" =
    (uaData?.mobile ?? (coarse || /Mobi|iPhone|Android/.test(ua))) ? "Mobile" : "Desktop";

  return { browser, os, device };
}
