import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Trello, spoken with an API key and a token (0.1.56).
 *
 * Trello has no status field: a card's status is the list it sits in. A
 * connection names a board and three of its lists — open, in progress,
 * resolved — and moving a card between them is a status change, both ways.
 * A card moved anywhere else is left alone.
 *
 * The key and token travel in Trello's OAuth-style Authorization header, not
 * the query string, so they stay out of access logs; the one exception is
 * Trello's own token-webhooks path, which names the token. The way
 * back is a webhook this server registers itself on the board; Trello signs
 * each delivery with the Power-Up's secret, which the owner pastes, and the
 * signature covers the callback URL as well as the body.
 */

export interface TrelloClientOptions {
  apiKey: string;
  token: string;
  /** https://api.trello.com/1, or a test's fake. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/** The three lists a connection moves cards between. */
export interface TrelloLists {
  open: string;
  progress: string;
  resolved: string;
}

export class TrelloError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status >= 500 || status === 429;
  }
}

export function trelloClient(opts: TrelloClientOptions) {
  const base = (opts.apiBase ?? "https://api.trello.com/1").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const q = (s: string) => s.replace(/["\\]/g, "");
  const auth = `OAuth oauth_consumer_key="${q(opts.apiKey)}", oauth_token="${q(opts.token)}"`;

  async function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { authorization: auth, accept: "application/json", "user-agent": "snagset", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new TrelloError(0, `could not reach Trello: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new TrelloError(401, "the API key and token were refused (revoked, expired, or from another key)");
    if (res.status === 403) throw new TrelloError(403, "the token is not allowed to do that on this board (it needs read and write)");
    if (res.status === 404) throw new TrelloError(404, "the board, list or card was not found, or the token cannot see it");
    if (!res.ok) throw new TrelloError(res.status, `Trello answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TrelloError(502, "Trello answered with something that is not JSON");
    }
  }

  const fail = (e: unknown) => ({ ok: false as const, detail: e instanceof Error ? e.message : String(e) });

  return {
    /**
     * What the connect dialog offers. With no board: who the token is and the
     * open boards it can see. With a board: that board's open lists.
     */
    async discover(boardId?: string): Promise<{ ok: true; who: string; options: { value: string; label: string }[] } | { ok: false; detail: string }> {
      try {
        const me = await call<{ fullName?: string; username?: string }>("GET", "/members/me?fields=fullName,username");
        const who = me.fullName || me.username || "Trello";
        if (boardId) {
          const lists = await call<{ id: string; name: string }[]>("GET", `/boards/${encodeURIComponent(boardId)}/lists?filter=open&fields=name`);
          return { ok: true, who, options: lists.map((l) => ({ value: l.id, label: l.name })) };
        }
        const boards = await call<{ id: string; name: string }[]>("GET", "/members/me/boards?filter=open&fields=name");
        return { ok: true, who, options: boards.map((b) => ({ value: b.id, label: b.name })) };
      } catch (e) {
        return fail(e);
      }
    },
    /** The board and its three lists, checked: each list open, on that board, and the three distinct. */
    async probe(boardId: string, lists: TrelloLists): Promise<{ ok: true; board: { id: string; name: string; url: string }; names: TrelloLists; who: string } | { ok: false; detail: string }> {
      try {
        const me = await call<{ fullName?: string; username?: string }>("GET", "/members/me?fields=fullName,username");
        const board = await call<{ id: string; name: string; url: string }>("GET", `/boards/${encodeURIComponent(boardId)}?fields=name,url`);
        const open = await call<{ id: string; name: string }[]>("GET", `/boards/${encodeURIComponent(boardId)}/lists?filter=open&fields=name`);
        const ids = [lists.open, lists.progress, lists.resolved];
        if (new Set(ids).size !== 3) return { ok: false, detail: "pick three different lists: one each for open, in progress and resolved" };
        const name = (id: string) => open.find((l) => l.id === id)?.name;
        const missing = ids.find((id) => !name(id));
        if (missing) return { ok: false, detail: `the list ${missing} is not an open list on the board ${board.name}` };
        return {
          ok: true,
          board: { id: board.id, name: board.name, url: board.url },
          names: { open: name(lists.open)!, progress: name(lists.progress)!, resolved: name(lists.resolved)! },
          who: me.fullName || me.username || "Trello",
        };
      } catch (e) {
        return fail(e);
      }
    },
    /**
     * A new board with exactly the three lists Snagset needs, To do, Doing and
     * Done, so the studio picks nothing (0.1.57). Trello's default lists are
     * left out; the board is private to the token's member.
     */
    async createBoard(name: string): Promise<{ ok: true; board: { id: string; name: string }; lists: { id: string; name: string }[] } | { ok: false; detail: string }> {
      try {
        const board = await call<{ id: string; name: string }>("POST", "/boards", { name: name.slice(0, 16384), defaultLists: false, prefs_permissionLevel: "private" });
        const lists: { id: string; name: string }[] = [];
        try {
          for (const listName of ["To do", "Doing", "Done"]) {
            const l = await call<{ id: string; name: string }>("POST", "/lists", { name: listName, idBoard: board.id, pos: "bottom" });
            lists.push({ id: l.id, name: l.name });
          }
        } catch (e) {
          // A half-made board is no use to anybody: take it down again.
          await call("DELETE", `/boards/${encodeURIComponent(board.id)}`).catch(() => {});
          throw e;
        }
        return { ok: true, board: { id: board.id, name: board.name }, lists };
      } catch (e) {
        return fail(e);
      }
    },
    async createCard(input: { listId: string; name: string; desc: string }): Promise<{ id: string; url: string }> {
      const made = await call<{ id: string; shortUrl?: string; url?: string }>("POST", "/cards", {
        idList: input.listId,
        name: input.name.slice(0, 16384),
        desc: input.desc.slice(0, 16384),
        pos: "top",
      });
      return { id: made.id, url: made.shortUrl ?? made.url ?? "" };
    },
    /**
     * Proof the way back works without the studio touching Trello (0.1.60): a
     * card made on the board and deleted at once. Each is an action on the
     * board, so the webhook delivers both, signed with the Power-Up's secret,
     * and the inbound route marks the connection delivered or refused.
     */
    async checkWebhook(listId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
      try {
        const made = await call<{ id: string }>("POST", "/cards", { idList: listId, name: "Snagset check", desc: "Made and deleted by Snagset to check the webhook. Nothing to do.", pos: "bottom" });
        await call("DELETE", `/cards/${encodeURIComponent(made.id)}`);
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },
    async moveCard(cardId: string, listId: string): Promise<void> {
      await call("PUT", `/cards/${encodeURIComponent(cardId)}`, { idList: listId });
    },
    /**
     * The way back: a webhook on the board, owned by this token. Trello
     * calls the address with HEAD first and refuses to register if it does
     * not answer 200. One that already exists for the same address, board
     * and token is found and reused rather than refused.
     */
    async registerWebhook(boardId: string, callbackURL: string): Promise<{ id: string }> {
      try {
        const made = await call<{ id: string }>("POST", "/webhooks", { callbackURL, idModel: boardId, description: "Snagset" });
        return { id: made.id };
      } catch (e) {
        if (!(e instanceof TrelloError) || e.status !== 400 || !/already exists/i.test(e.message)) throw e;
        const mine = await call<{ id: string; idModel: string; callbackURL: string }[]>("GET", `/tokens/${encodeURIComponent(opts.token)}/webhooks`);
        const found = mine.find((w) => w.idModel === boardId && w.callbackURL === callbackURL);
        if (!found) throw e;
        return { id: found.id };
      }
    },
    async removeWebhook(id: string): Promise<void> {
      await call("DELETE", `/webhooks/${encodeURIComponent(id)}`);
    },
  };
}

/**
 * `X-Trello-Webhook` is the base64 HMAC-SHA1 of the raw body followed by the
 * callback URL, keyed with the Power-Up's secret.
 */
export function verifyTrelloSignature(raw: string, callbackURL: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header.trim(), "base64");
  const want = createHmac("sha1", secret).update(raw + callbackURL, "utf8").digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Our status → the list a card belongs in; a list → our status, or null for any other list. */
export function trelloListFor(status: string, lists: TrelloLists): string {
  return status === "resolved" ? lists.resolved : status === "progress" || status === "review" ? lists.progress : lists.open;
}
export function statusForTrelloList(listId: string, lists: TrelloLists): "resolved" | "progress" | "open" | null {
  return listId === lists.resolved ? "resolved" : listId === lists.progress ? "progress" : listId === lists.open ? "open" : null;
}
