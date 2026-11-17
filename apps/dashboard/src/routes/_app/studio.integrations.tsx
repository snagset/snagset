import { useState } from "react";
import { Picker } from "@/components/app/Picker";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { AdminsOnly, PageHeader, SettingsRow } from "@/components/app/parts";
import { isOperator } from "@/lib/operator";
import { can } from "@/lib/roles";
import { api, ApiFailure, TRACKER_NAME, type Tracker, type TrackerIntegration } from "@/lib/api";
import { ago } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";
import { RowsPending } from "@/components/app/Pending";
import { McpCard } from "@/components/app/McpTokens";
import { ConnectTracker, SecretInput, WayBackDialog, type WayBack } from "@/components/app/ConnectTracker";

/**
 * Integrations — the set, GitHub first. One card per provider; a
 * card lists the sites it is connected on, each with its target, when
 * issues are made, and the health the worker last saw. A fine-grained token
 * per site, no OAuth app to register: the setup story a self-host can
 * actually finish.
 */
export const Route = createFileRoute("/_app/studio/integrations")({
  loader: ({ context }) => {
    if (can(context.queryClient.getQueryData(q.me().queryKey)?.user.role, "settings")) {
      void context.queryClient.prefetchQuery(q.integrations());
      void context.queryClient.prefetchQuery(q.mcpTokens());
    }
    return { crumb: "Integrations" };
  },
  // Trackers are an admin's. A member's own agent tokens live on You.
  component: () =>
    can(useMe().user.role, "settings") ? (
      <Integrations />
    ) : (
      <AdminsOnly title="Integrations">
        <p className="m-0">
          Connecting a site to GitHub, Linear, Jira or Slack is done by an owner or an admin. Your own agent tokens are on{" "}
          <Link to="/you" className="text-brand hover:underline">
            You
          </Link>
          .
        </p>
      </AdminsOnly>
    ),
});

const HEALTH: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { label: "Healthy", tone: "ok" },
  needs_reauth: { label: "Needs a new token", tone: "bad" },
  error: { label: "Failing", tone: "bad" },
};

function Integrations() {
  const me = useMe();
  // Owners and admins connect sites (a member is not shown this page).
  const owner = can(me.user.role, "settings");
  // The remote MCP switch is the instance's: an owner's, in the operator's
  // studio. Anyone else sees where it stands and cannot move it.
  const instanceOwner = can(me.user.role, "studio") && isOperator(me);
  const list = useQuery(q.integrations());
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });
  const [connecting, setConnecting] = useState<Tracker | null>(null);
  const [removing, setRemoving] = useState<TrackerIntegration | null>(null);
  const [webhook, setWebhook] = useState<{ provider: WayBack; site: string; siteName: string; target: { label: string; jiraSite?: string; repo?: string } } | null>(null);
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
  // A site put away or beyond the plan's cap is read-only: not one to connect.
  const usable = me.projects.filter((p) => !p.archived && !p.locked);
  const freeFor = (provider: Tracker) => usable.filter((p) => !rowsFor(provider).some((r) => r.site === p.uid));
  // Why there is no "Connect a site…" below, said once and with the way out:
  // the plan first (a site would not help), then the missing site.
  const blocked: "plan" | "site" | null = !owner ? null : !me.limits.integrations ? "plan" : usable.length === 0 ? "site" : null;

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="Integrations" sub="Your coding agent first, then the trackers that mirror a comment's status, then Slack, which only announces" />

      <McpCard owner={owner} instanceOwner={instanceOwner} operator={isOperator(me)} sites={me.projects} />

      {blocked && (
        <div role="note" className="flex max-w-[1040px] flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-[13px]">
          <span className="min-w-0 flex-1">
            {blocked === "plan"
              ? me.user.role === "owner"
                ? "This studio's plan does not include integrations. A plan that does lets you connect each site to GitHub, Linear, Jira and Slack."
                : "This studio's plan does not include integrations. An owner can change the plan."
              : me.projects.length === 0
                ? "An integration connects one site to one repository, team, project or channel. Add a site first, then connect it here."
                : "An integration connects one site at a time, and every site here is archived or read-only. Restore one, or add a site, then connect it here."}
          </span>
          {blocked === "plan" ? (
            me.user.role === "owner" && (
              <Button variant="outline" size="sm" render={<Link to="/studio/plan" />}>
                See plans
              </Button>
            )
          ) : (
            <Button variant="outline" size="sm" render={<Link to="/sites" />}>
              Go to Sites
            </Button>
          )}
        </div>
      )}

      {(["github", "linear", "jira", "trello", "slack"] as const).map((provider) => {
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
                    : provider === "trello"
                      ? "A comment becomes a card on the site's board, with the brief as its description. A card's list is its status: our status moves it between the three lists you pick, and moving it there moves the comment here. An API key and token from your own Power-Up; Snagset sets up the webhook."
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
                        : provider === "trello"
                          ? "No site is connected to a board yet."
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
                              : r.provider === "trello"
                                ? `${r.boardName} · ${r.listNames.open} / ${r.listNames.progress} / ${r.listNames.resolved}`
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
                          : r.provider === "trello"
                            ? r.createOn === "thread.created"
                              ? "A card for every new comment"
                              : "Cards when you ask, from the brief"
                            : r.createOn === "thread.created"
                              ? "An issue for every new comment"
                              : "Issues when you ask, from the brief"}
                        {r.provider === "github" && r.labels.length ? ` · labels ${r.labels.join(", ")}` : ""}
                        {" · "}
                        {ago(r.updatedAt)}
                      </span>
                      {r.provider !== "slack" && <WayBackLine r={r} />}
                      {r.lastError && <span className="basis-full text-[12px] text-destructive">{r.lastError}</span>}
                      {owner && (
                        <span className="ml-auto flex gap-1">
                          {r.provider !== "slack" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setWebhook({
                                  provider: r.provider,
                                  site: r.site,
                                  siteName: r.siteName ?? r.site,
                                  target:
                                    r.provider === "github"
                                      ? { label: `${r.owner}/${r.repo}`, repo: `${r.owner}/${r.repo}` }
                                      : r.provider === "linear"
                                        ? { label: r.teamName }
                                        : r.provider === "trello"
                                          ? { label: r.boardName }
                                          : { label: r.projectName, jiraSite: r.siteUrl },
                                })
                              }
                            >
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
            {owner && !blocked && free.length > 0 && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setConnecting(provider)}>
                  Connect a site…
                </Button>
              </div>
            )}
          </SettingsRow>
        );
      })}

      {(["github", "linear", "jira", "trello"] as const).map((pv) => (
        <ConnectTracker key={pv} provider={pv} open={connecting === pv} onOpenChange={(o) => !o && setConnecting(null)} sites={freeFor(pv)} />
      ))}
      <ConnectSlack open={connecting === "slack"} onOpenChange={(o) => !o && setConnecting(null)} sites={freeFor("slack")} onDone={() => void refresh()} />
      <WayBackDialog state={webhook} onClose={() => setWebhook(null)} />
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
            <Picker id="sl-site" value={chosen} onChange={setSite} options={sites.map((s) => ({ value: s.uid, label: s.name }))} />
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
            <SecretInput id="sl-token" placeholder="xoxb-…" value={token} onChange={setToken} />
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

/** The way back, on the row: whether the tracker's webhook has been heard from, and why it was refused if it was. */
function WayBackLine({ r }: { r: Exclude<TrackerIntegration, { provider: "slack" }> }) {
  const name = TRACKER_NAME[r.provider];
  // A taken delivery is signed and wins; a refused one is unsigned, so it
  // only heads the line while nothing has been taken.
  if (r.lastDeliveryAt) {
    const later = r.lastRefusedAt && Date.parse(r.lastRefusedAt) > Date.parse(r.lastDeliveryAt);
    return (
      <span className="basis-full text-[12px] text-muted-foreground">
        Webhook works · last delivery {ago(r.lastDeliveryAt)}
        {later ? ` · a later one was refused ${ago(r.lastRefusedAt!)}` : ""}
      </span>
    );
  }
  if (r.lastRefusedAt)
    return (
      <span className="basis-full text-[12px] text-destructive">
        Webhook refused {ago(r.lastRefusedAt)}: {r.lastRefusedError} Unsigned, so check {name}'s webhook log first.
      </span>
    );
  if (r.provider === "trello" && !r.webhookRegistered)
    return <span className="basis-full text-[12px] text-destructive">Snagset could not register the webhook on {r.boardName}: Trello must reach this server's address. Connect again once it can.</span>;
  if ((r.provider === "linear" || r.provider === "trello") && !r.hasWebhookSecret) return <span className="basis-full text-[12px] text-muted-foreground">No webhook yet, so {name} cannot move comments here. Webhook… sets it up.</span>;
  return <span className="basis-full text-[12px] text-muted-foreground">No webhook delivery seen yet. Webhook… shows how to set it up.</span>;
}
