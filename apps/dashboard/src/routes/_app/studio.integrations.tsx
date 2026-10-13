import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { PageHeader, SettingsRow } from "@/components/app/parts";
import { api, ApiFailure, MCP_SCOPES, TRACKER_NAME, type GitHubWebhook, type McpHttp, type McpScope, type McpToken, type Tracker, type TrackerIntegration } from "@/lib/api";
import { CopyButton } from "@/components/app/CopyButton";
import { ago } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";
import { RowsPending } from "@/components/app/Pending";

/**
 * Integrations — the set, GitHub first. One card per provider; a
 * card lists the sites it is connected on, each with its target, when
 * issues are made, and the health the worker last saw. A fine-grained token
 * per site, no OAuth app to register: the setup story a self-host can
 * actually finish.
 */
export const Route = createFileRoute("/_app/studio/integrations")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(q.integrations());
    void context.queryClient.prefetchQuery(q.mcpTokens());
    return { crumb: "Integrations" };
  },
  component: Integrations,
});

const HEALTH: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { label: "Healthy", tone: "ok" },
  needs_reauth: { label: "Needs a new token", tone: "bad" },
  error: { label: "Failing", tone: "bad" },
};

function Integrations() {
  const me = useMe();
  // Owners and admins connect sites and mint agent tokens; members only look.
  const owner = me.user.role === "owner" || me.user.role === "admin";
  const instanceOwner = me.user.role === "owner";
  const list = useQuery(q.integrations());
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });
  const [connecting, setConnecting] = useState<Tracker | null>(null);
  const [removing, setRemoving] = useState<TrackerIntegration | null>(null);
  const [webhook, setWebhook] = useState<{ site: string; provider: Tracker; hook: GitHubWebhook | { url: string }; fresh: boolean } | null>(null);
  const regenerate = useMutation({
    mutationFn: (uid: string) => api.regenerateGitHubWebhook(uid),
    onSuccess: ({ webhook: hook }, uid) => setWebhook({ site: uid, provider: "github", hook, fresh: false }),
    onError: (e) => toast.error(reason(e)),
  });
  const test = useMutation({
    mutationFn: ({ uid, provider }: { uid: string; provider: Tracker }) => api.testTracker(uid, provider).then((r) => ({ ...r, provider })),
    onSuccess: (r) => {
      toast[r.ok ? "success" : "error"](r.ok ? `${TRACKER_NAME[r.provider]} can see ${r.target}` : (r.detail ?? `${TRACKER_NAME[r.provider]} refused the token`));
      void refresh();
    },
    onError: (e) => toast.error(reason(e)),
  });
  const disconnect = useMutation({
    mutationFn: ({ uid, provider }: { uid: string; provider: Tracker }) => api.disconnectTracker(uid, provider),
    onSuccess: () => {
      setRemoving(null);
      void refresh();
    },
    onError: (e) => toast.error(reason(e)),
  });
  const rows = list.data?.data ?? [];
  const rowsFor = (provider: Tracker) => rows.filter((r) => r.provider === provider);
  const freeFor = (provider: Tracker) => me.projects.filter((p) => !rowsFor(provider).some((r) => r.site === p.uid));

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="Integrations" sub="Mirrors converge on the comment's status here; Slack only announces" />

      {(["github", "linear", "jira", "slack"] as const).map((provider) => {
        const mine = rowsFor(provider);
        const free = freeFor(provider);
        return (
          <SettingsRow
            key={provider}
            title={TRACKER_NAME[provider]}
            description={
              provider === "github"
                ? "A comment becomes an issue in the site's repository, with the brief as its body; resolving it here closes the issue there, and closing it there resolves it here. A fine-grained token per site — no OAuth app to register."
                : provider === "linear"
                  ? "A comment becomes an issue in the site's team, with the brief as its body; our status moves it between the team's workflow states by type, and a webhook from Linear moves it back. A personal API key per site — no OAuth app to register."
                  : provider === "jira"
                    ? "A comment becomes an issue in the site's Jira project, with the brief as its description; our status moves it through the workflow by status category, and a webhook from Jira moves it back. An API token with the account's email — what Atlassian gives a self-hoster."
                    : "One message per comment in a channel, edited in place as the status moves — never a second message, never a reply. A bot token from an app you create in a click from our manifest; Slack sends nothing back."
            }
          >
            {list.isPending && <RowsPending rows={2} />}
            {list.isSuccess && mine.length === 0 && (
              <div className="flex items-center gap-3">
                <Badge variant="outline">Not connected</Badge>
                <span className="text-[13px] text-muted-foreground">
                  {provider === "github"
                    ? "No site is connected to a repository yet."
                    : provider === "linear"
                      ? "No site is connected to a team yet."
                      : provider === "jira"
                        ? "No site is connected to a project yet."
                        : "No site is connected to a channel yet."}
                </span>
              </div>
            )}
            {mine.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {mine.map((r) => {
                  const h = HEALTH[r.health] ?? { label: r.health, tone: "warn" as const };
                  return (
                    <li key={`${r.provider}:${r.site}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2.5 text-[13px]">
                      <span className="font-medium">{r.siteName ?? r.site}</span>
                      <span className="text-muted-foreground">→</span>
                      <code className="font-mono text-[12.5px]">
                        {r.provider === "github"
                          ? `${r.owner}/${r.repo}`
                          : r.provider === "linear"
                            ? `${r.teamKey} · ${r.teamName}`
                            : r.provider === "jira"
                              ? `${r.projectKey} · ${r.projectName}`
                              : `#${r.channelName} · ${r.teamName}`}
                      </code>
                      <Badge variant="outline" className={h.tone === "ok" ? "border-ok text-ok" : h.tone === "bad" ? "border-destructive text-destructive" : ""}>
                        {h.label}
                      </Badge>
                      <span className="text-[12px] text-muted-foreground">
                        {r.provider === "slack"
                          ? r.createOn === "thread.created"
                            ? "A message for every new comment"
                            : "Messages when you ask, from the brief"
                          : r.createOn === "thread.created"
                            ? "An issue for every new comment"
                            : "Issues when you ask, from the brief"}
                        {r.provider === "github" && r.labels.length ? ` · labels ${r.labels.join(", ")}` : ""}
                        {r.provider !== "github" && r.provider !== "slack" && !r.hasWebhookSecret ? ` · no webhook secret yet, so ${TRACKER_NAME[r.provider]} cannot move comments here` : ""} · {ago(r.updatedAt)}
                      </span>
                      {r.lastError && <span className="basis-full text-[12px] text-destructive">{r.lastError}</span>}
                      {owner && (
                        <span className="ml-auto flex gap-1">
                          {r.provider === "github" ? (
                            <Button variant="ghost" size="sm" loading={regenerate.isPending} onClick={() => regenerate.mutate(r.site)}>
                              Webhook…
                            </Button>
                          ) : r.provider === "slack" ? null : (
                            <Button variant="ghost" size="sm" onClick={() => setWebhook({ site: r.site, provider: r.provider, hook: { url: `${location.origin}/api/v1/integrations/${r.provider}/inbound` }, fresh: false })}>
                              Webhook…
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" loading={test.isPending} onClick={() => test.mutate({ uid: r.site, provider: r.provider })}>
                            Test
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setRemoving(r)}>
                            Disconnect
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {owner && free.length > 0 && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setConnecting(provider)}>
                  Connect a site…
                </Button>
              </div>
            )}
          </SettingsRow>
        );
      })}

      <McpCard owner={owner} instanceOwner={instanceOwner} sites={me.projects} />

      <ConnectGitHub
        open={connecting === "github"}
        onOpenChange={(o) => !o && setConnecting(null)}
        sites={freeFor("github")}
        onDone={(uid, hook) => {
          void refresh();
          if (hook) setWebhook({ site: uid, provider: "github", hook, fresh: true });
        }}
      />
      <ConnectLinear
        open={connecting === "linear"}
        onOpenChange={(o) => !o && setConnecting(null)}
        sites={freeFor("linear")}
        onDone={(uid, hook) => {
          void refresh();
          setWebhook({ site: uid, provider: "linear", hook, fresh: true });
        }}
      />
      <ConnectJira
        open={connecting === "jira"}
        onOpenChange={(o) => !o && setConnecting(null)}
        sites={freeFor("jira")}
        onDone={(uid, hook) => {
          void refresh();
          setWebhook({ site: uid, provider: "jira", hook, fresh: true });
        }}
      />
      <ConnectSlack open={connecting === "slack"} onOpenChange={(o) => !o && setConnecting(null)} sites={freeFor("slack")} onDone={() => void refresh()} />
      <WebhookSetup state={webhook} onClose={() => setWebhook(null)} siteName={(uid) => rows.find((r) => r.site === uid)?.siteName ?? "the site"} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Disconnect ${removing?.siteName ?? "this site"} from ${removing ? TRACKER_NAME[removing.provider] : "the tracker"}?`}
        description={
          removing?.provider === "slack" ? (
            <>Messages already posted stay in the channel; no new ones are posted and they stop being updated. The token is forgotten.</>
          ) : (
            <>Issues already made keep their links; no new ones are made and status stops mirroring. The token is forgotten.</>
          )
        }
        confirmLabel="Disconnect"
        busy={disconnect.isPending}
        onConfirm={async () => {
          if (removing) await disconnect.mutateAsync({ uid: removing.site, provider: removing.provider });
        }}
      />
    </div>
  );
}

function ConnectGitHub({
  open,
  onOpenChange,
  sites,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
  onDone: (uid: string, webhook?: GitHubWebhook) => void;
}) {
  const [site, setSite] = useState("");
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [labels, setLabels] = useState("");
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  const connect = useMutation({
    mutationFn: (uid: string) =>
      api.connectTracker(uid, "github", { repository: repository.trim(), token: token.trim(), labels, createOn: auto ? "thread.created" : "manual" }),
  });
  const chosen = site || sites[0]?.uid || "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const made = await connect.mutateAsync(chosen);
      setRepository("");
      setToken("");
      setLabels("");
      setAuto(false);
      onOpenChange(false);
      onDone(chosen, made.webhook && "secret" in made.webhook ? made.webhook : undefined);
      toast.success("GitHub connected");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a site to GitHub</DialogTitle>
            <DialogDescription>
              A fine-grained personal access token with <b>Issues: read and write</b> on that one repository. It is checked
              against the repository before it is saved, and stored encrypted with this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-site">Site</Label>
            <select
              id="gh-site"
              value={chosen}
              onChange={(e) => setSite(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]"
            >
              {sites.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-repo">Repository</Label>
            <Input id="gh-repo" placeholder="kilnwork/site" value={repository} onChange={(e) => setRepository(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-token">Token</Label>
            <Input id="gh-token" type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-labels">Labels</Label>
            <Input id="gh-labels" placeholder="review, bug" value={labels} onChange={(e) => setLabels(e.target.value)} />
            <p className="m-0 text-[12px] text-muted-foreground">Applied to every issue this makes. Optional.</p>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="block font-medium">An issue for every new comment</span>
              <span className="block text-[12px] text-muted-foreground">
                Off by default: a reviewer walking a site leaves twenty comments and half are "never mind". Make issues from the
                brief when you mean it.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending} disabled={!repository.trim() || !token.trim() || !chosen}>
              {connect.isPending ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The other direction: GitHub tells us when an issue is closed or
 * reopened, through a repository webhook the operator registers by hand.
 * The secret is shown ONCE — here, right after connecting, or again after
 * "Webhook…" mints a new one and the old one stops working.
 */
function WebhookSetup({
  state,
  onClose,
  siteName,
}: {
  state: { site: string; provider: Tracker; hook: GitHubWebhook | { url: string }; fresh: boolean } | null;
  onClose: () => void;
  siteName: (uid: string) => string;
}) {
  const secret = state && "secret" in state.hook ? state.hook.secret : null;
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.fresh ? "Connected — now the webhook" : "Webhook for " + (state ? siteName(state.site) : "")}</DialogTitle>
          <DialogDescription>
            {state?.provider === "linear"
              ? "Issues moved in Linear move the comment here. In Linear › Settings › API › Webhooks, create one for the team with this URL and Issue events; then paste its signing secret when connecting or replacing the connection."
              : state?.provider === "jira"
                ? "Issues moved in Jira move the comment here. In Jira › Settings › System › Webhooks, create one with this URL, the events Issue updated and Issue deleted, and a secret; then paste the same secret when connecting or replacing the connection."
                : `Issues closed or reopened on GitHub move the comment here. Add a webhook to the repository — Settings › Webhooks › Add webhook — with these values. The secret is shown this once${state?.fresh ? "" : ", and the previous one has stopped working"}.`}
          </DialogDescription>
        </DialogHeader>
        {state && (
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Payload URL</dt>
            <dd className="m-0 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-[12px]">{state.hook.url}</code>
              <CopyButton text={state.hook.url} label="Copy the payload URL" />
            </dd>
            <dt className="text-muted-foreground">Content type</dt>
            <dd className="m-0">
              <code className="font-mono text-[12px]">application/json</code>
            </dd>
            {secret && (
              <>
                <dt className="text-muted-foreground">Secret</dt>
                <dd className="m-0 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-[12px]" data-testid="webhook-secret">
                    {secret}
                  </code>
                  <CopyButton text={secret} label="Copy the secret" />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Events</dt>
            <dd className="m-0">{state.provider === "linear" ? "Issues" : state.provider === "jira" ? "Issue: updated, deleted" : "Let me select individual events → Issues"}</dd>
          </dl>
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

function ConnectLinear({
  open,
  onOpenChange,
  sites,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
  onDone: (uid: string, webhook: { url: string }) => void;
}) {
  const [site, setSite] = useState("");
  const [team, setTeam] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  const connect = useMutation({
    mutationFn: (uid: string) =>
      api.connectTracker(uid, "linear", {
        team: team.trim(),
        apiKey: apiKey.trim(),
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
        createOn: auto ? "thread.created" : "manual",
      }),
  });
  const chosen = site || sites[0]?.uid || "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const made = await connect.mutateAsync(chosen);
      setTeam("");
      setApiKey("");
      setWebhookSecret("");
      setAuto(false);
      onOpenChange(false);
      onDone(chosen, made.webhook ?? { url: `${location.origin}/api/v1/integrations/linear/inbound` });
      toast.success("Linear connected");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a site to Linear</DialogTitle>
            <DialogDescription>
              A personal API key from Linear › Settings › API, belonging to a member of the team. It is checked against the
              team before it is saved, and stored encrypted with this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ln-site">Site</Label>
            <select id="ln-site" value={chosen} onChange={(e) => setSite(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]">
              {sites.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ln-team">Team key</Label>
            <Input id="ln-team" placeholder="ENG" value={team} onChange={(e) => setTeam(e.target.value)} autoComplete="off" />
            <p className="m-0 text-[12px] text-muted-foreground">The prefix of the team's issues, like the ENG in ENG-123.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ln-key">API key</Label>
            <Input id="ln-key" type="password" placeholder="lin_api_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ln-secret">Webhook signing secret</Label>
            <Input id="ln-secret" type="password" placeholder="from Linear's webhook, optional" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" />
            <p className="m-0 text-[12px] text-muted-foreground">
              Lets Linear move comments here when issues move there. The URL to give Linear is shown after connecting.
            </p>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="block font-medium">An issue for every new comment</span>
              <span className="block text-[12px] text-muted-foreground">Off by default. Make issues from the brief when you mean it.</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending} disabled={!team.trim() || !apiKey.trim() || !chosen}>
              {connect.isPending ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectJira({
  open,
  onOpenChange,
  sites,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
  onDone: (uid: string, webhook: { url: string }) => void;
}) {
  const [site, setSite] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [project, setProject] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  const connect = useMutation({
    mutationFn: (uid: string) =>
      api.connectTracker(uid, "jira", {
        siteUrl: siteUrl.trim(),
        project: project.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
        ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
        createOn: auto ? "thread.created" : "manual",
      }),
  });
  const chosen = site || sites[0]?.uid || "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const made = await connect.mutateAsync(chosen);
      setProject("");
      setApiToken("");
      setWebhookSecret("");
      setAuto(false);
      onOpenChange(false);
      onDone(chosen, made.webhook ?? { url: `${location.origin}/api/v1/integrations/jira/inbound` });
      toast.success("Jira connected");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string, type = "text", hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`jr-${id}`}>{label}</Label>
      <Input id={`jr-${id}`} type={type} placeholder={placeholder} value={value} onChange={(e) => set(e.target.value)} autoComplete="off" />
      {hint && <p className="m-0 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a site to Jira</DialogTitle>
            <DialogDescription>
              An API token from id.atlassian.com › Security, with the email of the account it belongs to. It is checked against
              the project before it is saved, and stored encrypted with this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jr-site">Site</Label>
            <select id="jr-site" value={chosen} onChange={(e) => setSite(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]">
              {sites.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {field("url", "Jira site", siteUrl, setSiteUrl, "https://kilnwork.atlassian.net")}
          {field("project", "Project key", project, setProject, "KAN", "text", "The prefix of the project's issues, like the KAN in KAN-12.")}
          {field("email", "Account email", email, setEmail, "you@kilnwork.studio", "email")}
          {field("token", "API token", apiToken, setApiToken, "", "password")}
          {field("secret", "Webhook secret", webhookSecret, setWebhookSecret, "the secret you typed into Jira's webhook, optional", "password", "Lets Jira move comments here when issues move there. The URL to give Jira is shown after connecting.")}
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="block font-medium">An issue for every new comment</span>
              <span className="block text-[12px] text-muted-foreground">Off by default. Make issues from the brief when you mean it.</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending} disabled={!siteUrl.trim() || !project.trim() || !email.trim() || !apiToken.trim() || !chosen}>
              {connect.isPending ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Slack: a bot token from an app the operator creates in one click
 * from our manifest, and a channel. Every new comment is posted by default —
 * Slack is where people are told, not where work is tracked — and the
 * message is edited in place as the status moves.
 */
function ConnectSlack({
  open,
  onOpenChange,
  sites,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
  onDone: (uid: string) => void;
}) {
  const [site, setSite] = useState("");
  const [channel, setChannel] = useState("");
  const [token, setToken] = useState("");
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState("");
  const manifest = useQuery({ queryKey: ["integrations", "slack", "manifest"], queryFn: () => api.slackManifest(), enabled: open, staleTime: Infinity });
  const connect = useMutation({
    mutationFn: (uid: string) => api.connectTracker(uid, "slack", { channel: channel.trim(), token: token.trim(), createOn: auto ? "thread.created" : "manual" }),
  });
  const chosen = site || sites[0]?.uid || "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await connect.mutateAsync(chosen);
      setChannel("");
      setToken("");
      setAuto(true);
      onOpenChange(false);
      onDone(chosen);
      toast.success("Slack connected");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a site to Slack</DialogTitle>
            <DialogDescription>
              Create the app in your workspace from our manifest — one click, the scopes are filled in — install it, and paste
              its Bot User OAuth Token. The token is checked against the channel before it is saved, and stored encrypted with
              this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sl-site">Site</Label>
            <select id="sl-site" value={chosen} onChange={(e) => setSite(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]">
              {sites.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-[13px]">
            <span className="flex-1">
              <span className="block font-medium">1. Create the app</span>
              <span className="block text-[12px] text-muted-foreground">Opens api.slack.com with the manifest pasted; then Install to Workspace.</span>
            </span>
            <Button type="button" variant="outline" size="sm" disabled={!manifest.data} render={<a href={manifest.data?.url ?? "#"} target="_blank" rel="noreferrer" />}>
              Create app…
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sl-token">2. Bot User OAuth Token</Label>
            <Input id="sl-token" type="password" placeholder="xoxb-…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <p className="m-0 text-[12px] text-muted-foreground">On the app's OAuth &amp; Permissions page after installing.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sl-channel">3. Channel</Label>
            <Input id="sl-channel" placeholder="#reviews" value={channel} onChange={(e) => setChannel(e.target.value)} autoComplete="off" />
            <p className="m-0 text-[12px] text-muted-foreground">A public channel by name; a private one needs the app invited first, then its name works too.</p>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="block font-medium">A message for every new comment</span>
              <span className="block text-[12px] text-muted-foreground">On by default: a channel is where people are told. Turn it off to post from the brief when you mean it.</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending} disabled={!channel.trim() || !token.trim() || !chosen}>
              {connect.isPending ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MCP — the fifth card. Agents read the same brief the dashboard
 * copies, and mark a fix ready — never resolved. A token is minted here,
 * shown once with the config that uses it, and revoked here; only its hash
 * is stored, so a lost one is replaced, not re-displayed.
 */
function McpCard({
  owner,
  instanceOwner,
  sites,
}: {
  /** May mint (owner or admin). */
  owner: boolean;
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
      title="MCP"
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
          <span className="text-[13px] text-muted-foreground">No agent can read this studio yet.</span>
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
