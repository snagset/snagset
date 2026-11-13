import { sanitise } from "@snagset/adapters";

/**
 * Slack, with a bot token, the "app" path for a self-host.
 *
 * Offers two paths. The incoming-webhook URL is thirty seconds of
 * setup but can only POST: no edit in place, no permalink, no way to say
 * "resolved" on the message people already saw. The decision wants one message
 * comment, edited in place as the status moves, so the connection is a bot
 * token (`xoxb-…`) from an app the operator creates once from a manifest
 * we hand them, plus a channel. Four Web API methods are all this needs.
 *
 * ESCAPING (the rules): every reviewer-typed string goes through the
 * adapters' `slack-mrkdwn` target before it reaches a block, and the plain
 * `text` fallback — which Slack renders and which notifies — is built from
 * `slack-plain` output. A reviewer, including through their display name,
 * cannot `@channel` a client's Slack.
 */

export interface SlackClientOptions {
  token: string;
  /** https://slack.com/api, or a test's fake. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

export class SlackError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "missing_scope"]);

export function slackClient(opts: SlackClientOptions) {
  const base = (opts.apiBase ?? "https://slack.com/api").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;

  async function call<T extends { ok: boolean }>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json; charset=utf-8", "user-agent": "snagset" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SlackError("unreachable", `could not reach Slack: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (res.status === 429) throw new SlackError("ratelimited", "Slack is rate limiting this app", true);
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) throw new SlackError("http", `Slack answered ${res.status}`, res.status >= 500);
    if (!parsed?.ok) {
      const code = String(parsed?.error ?? "unknown");
      const what =
        code === "invalid_auth" || code === "not_authed" || code === "token_revoked"
          ? "the bot token was refused"
          : code === "missing_scope"
            ? `the app lacks a scope it needs (${String(parsed?.needed ?? "chat:write")})`
            : code === "channel_not_found"
              ? "the channel was not found — a private channel needs the app invited into it"
              : code === "not_in_channel"
                ? "the app is not in that channel — invite it, or give it chat:write.public for public channels"
                : `Slack answered ${code}`;
      throw new SlackError(code, what, code === "internal_error" || code === "service_unavailable");
    }
    return parsed as T;
  }

  return {
    /** Who the token is, and where the workspace lives (for permalinks). */
    async whoami(): Promise<{ team: string; url: string; bot: string }> {
      const r = await call<{ ok: boolean; team: string; url: string; user: string }>("auth.test");
      return { team: r.team, url: r.url.replace(/\/+$/, ""), bot: r.user };
    },
    /** `#name` or a channel id → the channel; public channels by name, any channel by id. */
    async resolveChannel(input: string): Promise<{ id: string; name: string; isMember: boolean }> {
      const wanted = input.trim().replace(/^#/, "");
      if (/^[CG][A-Z0-9]{2,}$/.test(wanted)) {
        const r = await call<{ ok: boolean; channel: { id: string; name: string; is_member?: boolean } }>("conversations.info", { channel: wanted });
        return { id: r.channel.id, name: r.channel.name, isMember: !!r.channel.is_member };
      }
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const r = await call<{ ok: boolean; channels: { id: string; name: string; is_member?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
          "conversations.list",
          { types: "public_channel,private_channel", limit: 1000, exclude_archived: true, ...(cursor ? { cursor } : {}) },
        );
        const hit = r.channels.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
        if (hit) return { id: hit.id, name: hit.name, isMember: !!hit.is_member };
        cursor = r.response_metadata?.next_cursor ?? "";
        if (!cursor) break;
      }
      throw new SlackError("channel_not_found", `no channel called #${wanted} is visible to the app — a private channel needs the app invited into it`);
    },
    async post(channel: string, message: SlackMessage): Promise<{ ts: string; channel: string }> {
      const r = await call<{ ok: boolean; ts: string; channel: string }>("chat.postMessage", { channel, ...message, parse: "none", unfurl_links: false, unfurl_media: false });
      return { ts: r.ts, channel: r.channel };
    },
    async update(channel: string, ts: string, message: SlackMessage): Promise<void> {
      // chat.update defaults to parse=client, which would expand a typed @channel; say none.
      await call("chat.update", { channel, ts, ...message, parse: "none" });
    },
  };
}

export interface SlackMessage {
  text: string;
  blocks: Record<string, unknown>[];
}

export interface SlackMessageInput {
  key: string;
  status: string;
  statusWord: string;
  siteName: string;
  route: string;
  /** The element's label, when the anchor has one. */
  label: string | null;
  author: string;
  body: string | null;
  openUrl: string;
  pageUrl: string | null;
  environment?: string | null;
  browser?: string | null;
}

const STATUS_MARK: Record<string, string> = { open: "🔵", progress: "🟠", review: "🟣", resolved: "✅" };

/** The message, the shape: what, where, who, the words, and two buttons — edited in place as the status moves. */
export function slackMessage(i: SlackMessageInput): SlackMessage {
  const mark = STATUS_MARK[i.status] ?? "⚪";
  const md = (s: string, max: number) => String(sanitise(s, "slack-mrkdwn", { singleLine: true, max }));
  const plain = (s: string, max: number) => String(sanitise(s, "slack-plain", { singleLine: true, max }));
  const route = md(i.route, 150);
  const author = md(i.author, 80);
  const label = i.label ? md(i.label, 150) : "";
  const body = i.body ? String(sanitise(i.body, "slack-mrkdwn", { max: 500 })) : "";
  const context = [i.environment ? `\`${md(i.environment, 40)}\`` : "", i.browser ? md(i.browser, 150) : ""].filter(Boolean).join(" · ");
  return {
    // The fallback is rendered and notifies: plain, and never a name or a body raw.
    text: `${i.key} · ${i.statusWord} — ${plain(i.route, 150)} by ${plain(i.author, 80)}${i.body ? `: ${plain(i.body, 200)}` : ""}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${mark} *${i.key} · ${i.statusWord}* on ${md(i.siteName, 80)}\n*<${i.openUrl}|${route}>*${label ? ` — ${label}` : ""} · ${author}`,
        },
      },
      ...(body ? [{ type: "section", text: { type: "mrkdwn", text: body.split("\n").map((l) => `> ${l}`).join("\n") } }] : []),
      ...(context ? [{ type: "context", elements: [{ type: "mrkdwn", text: context }] }] : []),
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Open in Snagset" }, url: i.openUrl },
          ...(i.pageUrl ? [{ type: "button", text: { type: "plain_text", text: "Open the page" }, url: i.pageUrl }] : []),
        ],
      },
    ],
  };
}

/** The message's permalink from the workspace URL, the channel and the ts — no extra call. */
export function slackPermalink(teamUrl: string, channel: string, ts: string): string {
  return `${teamUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}

/** The manifest the operator creates the app from, one click. */
export function slackManifest(instanceName: string): Record<string, unknown> {
  return {
    display_information: { name: `Snagset · ${instanceName}`.slice(0, 35), description: "Review comments from Snagset, one message each, kept up to date." },
    features: { bot_user: { display_name: "Snagset", always_online: false } },
    oauth_config: { scopes: { bot: ["chat:write", "chat:write.public", "channels:read", "groups:read"] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}
