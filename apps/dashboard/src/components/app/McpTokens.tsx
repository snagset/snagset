import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { CopyButton } from "@/components/app/CopyButton";
import { SettingsRow } from "@/components/app/parts";
import { RowsPending } from "@/components/app/Pending";
import { api, ApiFailure, MCP_SCOPES, type McpHttp, type McpScope, type McpToken } from "@/lib/api";
import { ago } from "@/lib/labels";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";

/*
 * Moved out of the Integrations route so You can draw it too: a member
 * keeps their own agent tokens there, and a route file's components are
 * code-split with the route, not shared.
 */

/**
 * MCP — the fifth card. Agents read the same brief the dashboard
 * copies, and mark a fix ready — never resolved. A token is minted here,
 * shown once with the config that uses it, and revoked here; only its hash
 * is stored, so a lost one is replaced, not re-displayed.
 */
export function McpCard({
  owner,
  instanceOwner,
  sites,
  mine = false,
}: {
  /** May mint — everyone who reviews. */
  owner: boolean;
  /** The list is the viewer's own tokens (a member's, on You), not the studio's. */
  mine?: boolean;
  /** The remote-transport switch is instance-wide: the owner's alone. */
  instanceOwner: boolean;
  sites: { uid: string; name: string }[];
}) {
  const qc = useQueryClient();
  const list = useQuery(q.mcpTokens());
  const [minting, setMinting] = useState(false);
  const [shown, setShown] = useState<{ token: McpToken; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<McpToken | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeMcpToken(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
    },
    onError: (e) => toast.error(reason(e)),
  });
  const rows = list.data?.data ?? [];
  const live = rows.filter((t) => !t.revokedAt);
  const http = list.data?.http ?? null;
  // The remote transport is a switch here, not a line in an env file
  // unless the environment names it, in which case the switch says so and stays.
  const remote = useMutation({
    mutationFn: (enabled: boolean) => api.setMcpHttp(enabled),
    onSuccess: (next, enabled) => {
      qc.setQueryData(q.instance().queryKey, next);
      void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
      toast.success(enabled ? "Remote transport on — the token dialog shows its config" : "Remote transport off — the endpoint answers 404 again");
    },
    onError: (e) => toast.error(reason(e)),
  });
  const scopeLabel = (scopes: string[]) => {
    const set = new Set(scopes);
    const writes = set.has("comments:write") || set.has("threads:write");
    if (!writes && !set.has("context:read")) return "Read-only";
    if (!writes) return "Read-only, with capture context";
    return `Writes: ${[set.has("comments:write") ? "reply" : "", set.has("threads:write") ? "mark ready" : ""].filter(Boolean).join(", ")}`;
  };
  return (
    <SettingsRow
      title={mine ? "Your agent tokens" : "MCP"}
      description="A coding agent — Claude Code, Cursor, any MCP client — reads the same brief this dashboard copies, maps a comment to the file in its checkout, and can reply or mark a fix ready. It never resolves: whoever reported a snag decides when it is fixed. A token per agent, shown once, revocable here."
    >
      {list.isPending && <RowsPending rows={2} />}
      {http && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <div>
            <Label htmlFor="mcp-http-on" className="text-[13px] font-medium">
              Remote transport
            </Label>
            <p className="m-0 mt-0.5 text-[12px] leading-normal text-muted-foreground">
              {http.enabled ? (
                <>
                  On. An agent anywhere talks to this studio at <code className="font-mono text-[11.5px]">{http.url}</code> with a token as a bearer. No source mapping there; a write needs a token minted for it.
                </>
              ) : (
                <>
                  Off. Agents reach this studio only from a machine with the checkout. On, <code className="font-mono text-[11.5px]">{http.url}</code> serves the same tools to an agent anywhere, with a token as a bearer.
                </>
              )}
              {http.source === "env" ? " Set by the environment (SNAGSET_MCP_HTTP_ENABLED)." : ""}
            </p>
          </div>
          <Switch
            id="mcp-http-on"
            aria-label="Remote transport"
            checked={http.enabled}
            disabled={!instanceOwner || http.source === "env" || remote.isPending}
            onCheckedChange={(on) => remote.mutate(on)}
          />
        </div>
      )}
      {list.isSuccess && live.length === 0 && (
        <div className="flex items-center gap-3">
          <Badge variant="outline">No tokens</Badge>
          <span className="text-[13px] text-muted-foreground">{mine ? "You have no agent tokens yet." : "No agent can read this studio yet."}</span>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Agent tokens">
          {rows.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2.5 text-[13px] ${t.revokedAt ? "opacity-60" : ""}`}>
              <span className="font-medium">{t.name}</span>
              <code className="font-mono text-[12.5px] text-muted-foreground">{t.prefix}…</code>
              <Badge variant="outline" className={t.revokedAt ? "" : "border-ok text-ok"}>
                {t.revokedAt ? "Revoked" : scopeLabel(t.scopes)}
              </Badge>
              <span className="text-[12px] text-muted-foreground">
                {t.site ? t.site.name : "All sites"} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : "never used"}
                {t.expiresAt && !t.revokedAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
                {t.createdBy ? ` · by ${t.createdBy}` : ""}
              </span>
              {t.canRevoke && (
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(t)}>
                    Revoke
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {owner && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setMinting(true)}>
            New token…
          </Button>
        </div>
      )}
      <NewToken
        open={minting}
        onOpenChange={setMinting}
        sites={sites}
        http={list.data?.http ?? null}
        onDone={(made) => {
          void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
          setShown(made);
        }}
      />
      <TokenShown state={shown} http={list.data?.http ?? null} onClose={() => setShown(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description={<>The agent holding it loses access on its next request. Its past replies stay, under its name. This cannot be undone — mint a new token instead.</>}
        confirmLabel="Revoke"
        busy={revoke.isPending}
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
        }}
      />
    </SettingsRow>
  );
}

function NewToken({
  open,
  onOpenChange,
  sites,
  http,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
  http: McpHttp | null;
  onDone: (made: { token: McpToken; secret: string }) => void;
}) {
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [scopes, setScopes] = useState<McpScope[]>(["threads:read", "source:map"]);
  const [expires, setExpires] = useState("");
  const [remote, setRemote] = useState(false);
  const [error, setError] = useState("");
  const mint = useMutation({
    mutationFn: () =>
      api.mintMcpToken({
        name: name.trim(),
        ...(site ? { site } : {}),
        scopes,
        ...(expires ? { expiresInDays: Number(expires) } : {}),
        ...(remote ? { allowRemoteWrites: true } : {}),
      }),
  });
  const toggle = (scope: McpScope, on: boolean) => setScopes((s) => (on ? [...new Set([...s, scope])] : s.filter((x) => x !== scope)));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const made = await mint.mutateAsync();
      setName("");
      setSite("");
      setScopes(["threads:read", "source:map"]);
      setExpires("");
      setRemote(false);
      onOpenChange(false);
      onDone(made);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New agent token</DialogTitle>
            <DialogDescription>
              Read-only by default, plus mapping a comment to a file in the agent's own checkout. Tick more only for an agent
              you want writing here — and it still cannot resolve anything.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input id="mcp-name" placeholder="Claude Code" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
            <p className="m-0 text-[12px] text-muted-foreground">What a client sees on the agent's replies, so name the agent, not the person.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-site">Site</Label>
            <select id="mcp-site" value={site} onChange={(e) => setSite(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]">
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-[13px] font-medium">Scopes</legend>
            {MCP_SCOPES.map((s) => (
              <label key={s.scope} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                <input type="checkbox" className="mt-0.5" checked={scopes.includes(s.scope)} onChange={(e) => toggle(s.scope, e.target.checked)} />
                <span>
                  <span className="block font-medium">{s.label}</span>
                  <span className="block text-[12px] text-muted-foreground">{s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {http?.enabled && (scopes.includes("comments:write") || scopes.includes("threads:write")) && (
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
              <span>
                <span className="block font-medium">May write over the remote transport</span>
                <span className="block text-[12px] text-muted-foreground">
                  Off by default. Over POST /mcp the agent is not on a machine you can see; a write there is a decision.
                </span>
              </span>
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-expires">Expires</Label>
            <select id="mcp-expires" value={expires} onChange={(e) => setExpires(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]">
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mint.isPending} disabled={!name.trim() || scopes.length === 0}>
              {mint.isPending ? "Minting…" : "Create token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The token, ONCE, with the config that uses it — copied, not retyped. */
function TokenShown({
  state,
  http,
  onClose,
}: {
  state: { token: McpToken; secret: string } | null;
  http: McpHttp | null;
  onClose: () => void;
}) {
  const host = typeof location !== "undefined" ? location.origin : "";
  const env: Record<string, string> = { SNAGSET_MCP_TOKEN: state?.secret ?? "", SNAGSET_MCP_HOST: host, ...(state?.token.site ? { SNAGSET_MCP_PROJECT: state.token.site.uid } : {}) };
  const json = JSON.stringify({ mcpServers: { snagset: { command: "npx", args: ["-y", "@snagset/mcp"], env } } }, null, 2);
  // Assembled from parts, not one template: the SQL-comment linter reads a
  // line carrying both a double dash and a backtick as a comment that would
  // end the literal, and it is right to be blunt about that everywhere.
  const claude = [
    "claude mcp add snagset",
    ...Object.entries(env).map(([k, v]) => `-e ${k}=${v}`),
    "--",
    "npx -y @snagset/mcp",
  ].join(" ");
  // The same token over POST /mcp, for an agent with no checkout.
  const bearer = `Bearer ${state?.secret ?? ""}`;
  const remoteClaude = ["claude mcp add", "--transport http", "snagset", http?.url ?? "", `--header "Authorization: ${bearer}"`].join(" ");
  const remoteJson = JSON.stringify({ mcpServers: { snagset: { type: "http", url: http?.url ?? "", headers: { Authorization: bearer } } } }, null, 2);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      {/* sm:, to beat the base's sm:max-w-sm — a bare max-w-xl lost to it on
          every screen wider than a phone, and the dialog stayed 24rem. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Token for “{state?.token.name ?? ""}”</DialogTitle>
          <DialogDescription>
            Shown this once — only its hash is stored. Put it in the agent's config, then start the agent from the site's checkout so
            it can map comments to files.
          </DialogDescription>
        </DialogHeader>
        {state && (
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[12px]" data-testid="mcp-token">
                {state.secret}
              </code>
              <CopyButton text={state.secret} label="Copy the token" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium">Claude Code</span>
                <CopyButton text={claude} label="Copy the Claude Code command" />
              </div>
              <pre className="m-0 whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-[12px]">{claude}</pre>
            </div>
            {http?.enabled && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Remote — an agent that is not on a machine with the checkout</span>
                  <CopyButton text={remoteJson} label="Copy the remote config" />
                </div>
                <pre className="m-0 whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-[12px]">{remoteClaude}</pre>
                <pre className="m-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px]">{remoteJson}</pre>
                <p className="m-0 text-[12px] text-muted-foreground">
                  No source mapping there — nothing to search. Writes need the token minted with remote writes allowed.
                </p>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium">Cursor, Claude Desktop, any MCP client</span>
                <CopyButton text={json} label="Copy the JSON config" />
              </div>
              <pre className="m-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px]">{json}</pre>
              <p className="m-0 text-[12px] text-muted-foreground">Cursor reads it from .cursor/mcp.json in the project; Claude Desktop from its claude_desktop_config.json.</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
