import { randomBytes } from "node:crypto";

/**
 * How a person gets into a studio in a test, now that it is how they get in
 * for real: an owner mints an invite, the invitee accepts it. Not a
 * `*.test.ts`, so the runner does not pick it up as a suite.
 *
 * Each accept comes from its own made-up address, because the public invite
 * routes are rate-limited per address in process memory and a suite that
 * adds a dozen people would otherwise trip the limit it is not testing.
 */
type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const json = { "content-type": "application/json" };

export const someAddress = (): string => `10.${randomBytes(3).join(".")}`;

/** Mint one. The response is returned as-is when it is not a 201, so a caller can assert the refusal. */
export async function invite(app: Requester, headers: Record<string, string>, body: { role?: string; email?: string }): Promise<Response> {
  return app.request("/api/v1/members/invites", { method: "POST", headers, body: JSON.stringify({ role: "admin", ...body }) });
}

export function accept(app: Requester, body: Record<string, unknown>, from = someAddress()): Promise<Response> {
  return Promise.resolve(app.request("/auth/invites/accept", { method: "POST", headers: { ...json, "x-forwarded-for": from }, body: JSON.stringify(body) }));
}

/** Invite and accept in one: the 201 of the accept, or whichever step refused. */
export async function join(
  app: Requester,
  headers: Record<string, string>,
  who: { email: string; name?: string; role?: string; password: string },
): Promise<Response> {
  const made = await invite(app, headers, { role: who.role ?? "admin", email: who.email });
  if (made.status !== 201) return made;
  const { token } = (await made.json()) as { token: string };
  return accept(app, { token, name: who.name ?? "", password: who.password });
}
