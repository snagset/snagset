import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/app/CopyButton";
import { Picker } from "@/components/app/Picker";
import { api, ApiFailure, TRACKER_NAME, type TrackerIntegration } from "@/lib/api";
import { ago } from "@/lib/labels";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";

/**
 * Connecting a tracker, in three steps (0.1.55) — what a live run of the
 * one long form taught: people pasted a project's name where its key went,
 * met the webhook address only after the form that needed it, and had no
 * way to tell a wrong secret from a quiet tracker. So:
 *
 *   1. Access — the credentials, checked at once; the answer lists what
 *      they can see.
 *   2. Connect — pick the repository, team or project from that list.
 *   3. Way back — the webhook's address and secret side by side, and a line
 *      that turns into a tick when the tracker's first delivery arrives, or
 *      says in words why it was refused.
 *
 * Trello (0.1.56) picks a board and then three of its lists, and its
 * webhook is registered by Snagset; the owner pastes only the secret.
 *
 * Slack has no way back and keeps its own dialog.
 */

export type WayBack = "github" | "linear" | "jira" | "trello";
const GUIDE = "https://snagset.com/docs/integrations/";
const PICK: Record<WayBack, string> = { github: "Repository", linear: "Team", jira: "Project", trello: "Board" };
/** Trello's own page that hands a token to the key typed above it. */
const trelloAuthorize = (key: string) =>
  `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Snagset&key=${encodeURIComponent(key.trim())}`;
/** A first guess at which list is which, by the names most boards use; the owner changes any of them. */
function guessLists(lists: { value: string; label: string }[]) {
  const by = (re: RegExp) => lists.find((l) => re.test(l.label))?.value;
  const open = by(/^(to ?do|backlog|open|new|inbox)/i) ?? lists[0]?.value ?? "";
  const resolved = by(/^(done|complete|resolved|shipped|fixed)/i) ?? lists[lists.length - 1]?.value ?? "";
  const progress = by(/(doing|progress|review|working)/i) ?? lists.find((l) => l.value !== open && l.value !== resolved)?.value ?? "";
  return { open, progress, resolved };
}

/** A key or secret field with an eye to show what was pasted. */
export function SecretInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="pr-9 font-mono text-[12.5px]"
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide" : "Show"}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {shown ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  const names = ["Access", "Connect", "Way back"];
  return (
    <ol className="m-0 flex list-none items-center gap-2 p-0 text-[12px]" aria-label="Steps">
      {names.map((n, i) => {
        const step = (i + 1) as 1 | 2 | 3;
        return (
          <li key={n} aria-current={step === at ? "step" : undefined} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums",
                step < at && "border-transparent bg-primary text-primary-foreground",
                step === at && "border-primary text-foreground",
                step > at && "border-border text-muted-foreground",
              )}
            >
              {step < at ? <CheckIcon className="size-3" /> : step}
            </span>
            <span className={step === at ? "font-medium text-foreground" : "text-muted-foreground"}>{n}</span>
            {i < names.length - 1 && <span className="h-px w-5 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="m-0 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
      {children}
    </p>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-2">
      {children}
    </a>
  );
}

const failed = (err: unknown) => (err instanceof ApiFailure ? err.message : "Could not reach the server.");

/** Where each tracker hands out the credential step 1 asks for, as numbered steps. */
function AccessHowTo({ provider, jiraSite, trelloKey = "" }: { provider: WayBack; jiraSite: string; trelloKey?: string }) {
  const steps =
    provider === "trello"
      ? [
          <>
            Open <Ext href="https://trello.com/power-ups/admin">Trello › Power-Ups admin</Ext>. Make a Power-Up called Snagset if you have none (any workspace), then
            open its API key tab and generate a key.
          </>,
          <>Paste the API key below.</>,
          trelloKey.trim() ? (
            <>
              <Ext href={trelloAuthorize(trelloKey)}>Generate a token</Ext> for that key: Allow, copy the token, paste it below.
            </>
          ) : (
            <>Then a link here makes the token for that key: Allow, copy it, paste it below.</>
          ),
        ]
      : provider === "github"
      ? [
          <>
            Open <Ext href="https://github.com/settings/personal-access-tokens/new">GitHub › Fine-grained tokens › Generate new token</Ext>.
          </>,
          <>Repository access: only the site's repository. Permissions › Issues: Read and write.</>,
          <>Generate, copy the token, paste it below.</>,
        ]
      : provider === "linear"
        ? [
            <>
              Open <Ext href="https://linear.app/settings/account/security">Linear › Settings › Security & access</Ext>.
            </>,
            <>Under Personal API keys, make a new key. It acts as you, so you must be in the team.</>,
            <>Copy the key, paste it below.</>,
          ]
        : [
            <>
              Open <Ext href="https://id.atlassian.com/manage-profile/security/api-tokens">Atlassian account › Security › API tokens</Ext>.
            </>,
            <>Create API token — the plain one, not "with scopes". Name it Snagset.</>,
            <>
              Copy it, paste it below with the email you sign in to {jiraSite ? jiraSite.replace(/^https?:\/\//, "") : "Jira"} with.
            </>,
          ];
  return (
    <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

/**
 * Step 3 on its own — also what a connected row's "Webhook…" opens. The
 * address and secret, numbered steps for the tracker's own form, and the
 * live line: the card's record of the last delivery, asked every few
 * seconds while this is open.
 */
export function WayBackStep({
  provider,
  site,
  shownSecret,
  target,
  onSecret,
}: {
  provider: WayBack;
  site: string;
  /** A secret Snagset minted, shown this once (GitHub, Jira). */
  shownSecret: string | null;
  /** What the connection points at, for the instructions: "acme/site", the team, the Jira site. */
  target: { label: string; jiraSite?: string; repo?: string; trelloNote?: string };
  onSecret: (secret: string | null) => void;
}) {
  const qc = useQueryClient();
  const url = `${location.origin}/api/v1/integrations/${provider}/inbound`;
  const [since] = useState(() => Date.now());
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const list = useQuery({ ...q.integrations(), refetchInterval: 3000 });
  const row = list.data?.data.find((i) => i.site === site && i.provider === provider) as TrackerIntegration | undefined;
  const save = useMutation({
    mutationFn: (secret?: string) => api.setWebhookSecret(site, provider, secret),
    onSuccess: (r) => {
      setError("");
      setPaste("");
      onSecret(r.webhook.secret ?? null);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(provider === "linear" ? "Signing secret saved" : provider === "trello" ? "Secret saved" : "New secret made — the old one has stopped working");
    },
    onError: (err) => setError(failed(err)),
  });
  // A taken delivery is signed, so it is the tracker's and it wins. A refused
  // one is unsigned and could be anybody's: it heads the box only while
  // nothing has been taken, and after that it is a note underneath.
  const at = row?.lastDeliveryAt ? Date.parse(row.lastDeliveryAt) : 0;
  const refusedAt = row?.lastRefusedAt ? Date.parse(row.lastRefusedAt) : 0;
  const state: "waiting" | "ok" | "refused" | "nosecret" =
    (provider === "linear" || provider === "trello") && row && !row.hasWebhookSecret ? "nosecret" : at ? "ok" : refusedAt ? "refused" : "waiting";
  const laterRefusal = state === "ok" && refusedAt > at;
  const trigger =
    provider === "github"
      ? "GitHub sends a test delivery the moment the webhook is saved."
      : provider === "trello"
        ? `Then move any card on ${target.label} to another list once.`
        : provider === "linear"
        ? `Then move any issue in ${target.label} to another status once.`
        : `Then move any issue in ${target.label} once.`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error && <Alert>{error}</Alert>}
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
        {provider === "github" ? (
          <>
            <li>
              Open{" "}
              <Ext href={target.repo ? `https://github.com/${target.repo}/settings/hooks/new` : "https://github.com"}>
                the repository's Settings › Webhooks › Add webhook
              </Ext>
              .
            </li>
            <li>Paste the address and the secret below; content type application/json.</li>
            <li>"Let me select individual events" → tick Issues only. Add webhook.</li>
          </>
        ) : provider === "trello" ? (
          <>
            <li>
              {row && !(row as { webhookRegistered?: boolean }).webhookRegistered
                ? `Snagset could not register the webhook on ${target.label}${target.trelloNote ? `: ${target.trelloNote}` : ""}. Trello must be able to reach this server's address; connect again once it can.`
                : `Snagset registered the webhook on ${target.label} for you: nothing to set up in Trello.`}
            </li>
            <li>
              Trello signs each delivery with your Power-Up's secret. Open <Ext href="https://trello.com/power-ups/admin">Trello › Power-Ups admin</Ext>, your Power-Up's
              API key tab, and copy the Secret.
            </li>
            <li>Paste it below.</li>
          </>
        ) : provider === "linear" ? (
          <>
            <li>
              Open <Ext href="https://linear.app/settings/api">Linear › Settings › API</Ext>, then Webhooks › New webhook.
            </li>
            <li>Paste the address; pick the team {target.label}; under data change events tick Issues. Create.</li>
            <li>Linear shows a signing secret: copy it and paste it below.</li>
          </>
        ) : (
          <>
            <li>
              Open{" "}
              <Ext href={target.jiraSite ? `${target.jiraSite}/plugins/servlet/webhooks` : "https://admin.atlassian.com"}>Jira › Settings › System › WebHooks</Ext>{" "}
              › Create a WebHook. It needs a Jira admin.
            </li>
            <li>Paste the address and the secret below.</li>
            <li>Under Issue, tick updated and deleted. Create.</li>
          </>
        )}
      </ol>

      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-[13px]">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="m-0 flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-[12px]" data-testid="webhook-url">
            {url}
          </code>
          <CopyButton text={url} label="Copy the address" />
        </dd>
        {provider !== "linear" && provider !== "trello" && (
          <>
            <dt className="text-muted-foreground">Secret</dt>
            <dd className="m-0 flex min-w-0 items-center gap-2">
              {shownSecret ? (
                <>
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-[12px]" data-testid="webhook-secret">
                    {shownSecret}
                  </code>
                  <CopyButton text={shownSecret} label="Copy the secret" />
                </>
              ) : (
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-muted-foreground">
                  Shown once, when it was made.
                  <Button type="button" size="sm" variant="outline" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                    Make a new secret
                  </Button>
                </span>
              )}
            </dd>
          </>
        )}
        {provider === "github" && (
          <>
            <dt className="text-muted-foreground">Content type</dt>
            <dd className="m-0 font-mono text-[12px]">application/json</dd>
          </>
        )}
      </dl>
      {shownSecret && <p className="m-0 -mt-2 text-[12px] text-muted-foreground">Copy it now: it is not shown again. A new one can be made here any time.</p>}

      {(provider === "linear" || provider === "trello") && (
        <Field
          id="wb-secret"
          label={provider === "linear" ? "Signing secret" : "Power-Up secret"}
          hint={row?.hasWebhookSecret ? "Saved. Paste a new one to replace it." : provider === "linear" ? "From the webhook Linear just made." : "Next to the API key in Trello."}
        >
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <SecretInput id="wb-secret" value={paste} onChange={setPaste} placeholder={provider === "linear" ? "lin_wh_…" : ""} />
            </div>
            <Button type="button" variant="outline" disabled={!paste.trim()} loading={save.isPending} onClick={() => save.mutate(paste.trim())}>
              Save
            </Button>
          </div>
        </Field>
      )}

      <div
        role="status"
        aria-live="polite"
        data-testid="webhook-check"
        data-state={state}
        className={cn(
          "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[13px]",
          state === "ok" && "border-emerald-500/40 bg-emerald-500/10",
          state === "refused" && "border-destructive/40 bg-warn-soft",
          (state === "waiting" || state === "nosecret") && "border-border bg-muted/40",
        )}
      >
        {state === "ok" ? (
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : state === "refused" ? (
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        )}
        <span className="min-w-0">
          {state === "ok" ? (
            <>
              <span className="font-medium">The webhook works.</span> Last delivery {ago(row!.lastDeliveryAt!)}
              {at >= since ? ", just now." : "."}
              {laterRefusal && (
                <span className="mt-1 block text-muted-foreground">
                  A later delivery was refused ({ago(row!.lastRefusedAt!)}): {row!.lastRefusedError} If you did not change the secret, it may not have come from {TRACKER_NAME[provider]}.
                </span>
              )}
            </>
          ) : state === "refused" ? (
            <>
              <span className="font-medium">A delivery arrived and was refused</span> ({ago(row!.lastRefusedAt!)}). {row!.lastRefusedError}
              <span className="mt-1 block text-muted-foreground">
                A refused delivery is unsigned, so it may not be from {TRACKER_NAME[provider]}. Check the delivery log on {TRACKER_NAME[provider]}'s webhook before changing anything.
              </span>
            </>
          ) : state === "nosecret" ? (
            <>Waiting for the {provider === "linear" ? "signing secret" : "Power-Up's secret"}. Without it, {TRACKER_NAME[provider]}'s deliveries are refused.</>
          ) : (
            <>
              <span className="font-medium">Waiting for the first delivery.</span> {trigger}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The three-step connect for GitHub, Linear, Jira and Trello. */
export function ConnectTracker({
  provider,
  open,
  onOpenChange,
  sites,
}: {
  provider: WayBack;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sites: { uid: string; name: string }[];
}) {
  const qc = useQueryClient();
  const name = TRACKER_NAME[provider];
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [site, setSite] = useState("");
  const [token, setToken] = useState("");
  const [jiraSite, setJiraSite] = useState("");
  const [email, setEmail] = useState("");
  const [trKey, setTrKey] = useState("");
  const [trLists, setTrLists] = useState<{ value: string; label: string }[]>([]);
  const [trPick, setTrPick] = useState({ open: "", progress: "", resolved: "" });
  const [trNote, setTrNote] = useState("");
  const [who, setWho] = useState("");
  const [options, setOptions] = useState<{ value: string; label: string; canWrite?: boolean }[]>([]);
  const [target, setTarget] = useState("");
  const [labels, setLabels] = useState("");
  const [auto, setAuto] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [connectedSite, setConnectedSite] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) return;
    // Closing forgets everything typed: a token must not sit in memory for the next opening.
    setStep(1);
    setSite("");
    setToken("");
    setJiraSite("");
    setEmail("");
    setTrKey("");
    setTrLists([]);
    setTrPick({ open: "", progress: "", resolved: "" });
    setTrNote("");
    setWho("");
    setOptions([]);
    setTarget("");
    setLabels("");
    setAuto(false);
    setSecret(null);
    setConnectedSite("");
    setError("");
  }, [open]);

  const chosen = site || sites[0]?.uid || "";
  const siteUrl = jiraSite.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
  const access =
    provider === "github"
      ? { token: token.trim() }
      : provider === "linear"
        ? { apiKey: token.trim() }
        : provider === "trello"
          ? { apiKey: trKey.trim(), token: token.trim() }
          : { siteUrl, email: email.trim(), apiToken: token.trim() };

  // Trello's second half of step 2: a board's lists, asked when a board is picked.
  // The board asked for last is the only one whose answer counts: pick A then
  // B quickly, and A's late answer must not fill B's three lists.
  const askedBoard = useRef("");
  const lists = useMutation({
    mutationFn: (boardId: string) => api.discoverTracker("trello", { apiKey: trKey.trim(), token: token.trim(), boardId }),
    onSuccess: (r, boardId) => {
      if (boardId !== askedBoard.current) return;
      setError("");
      setTrLists(r.options);
      setTrPick(guessLists(r.options));
    },
    onError: (err, boardId) => {
      if (boardId === askedBoard.current) setError(failed(err));
    },
  });
  const pickBoard = (boardId: string) => {
    askedBoard.current = boardId;
    setTarget(boardId);
    setTrLists([]);
    setTrPick({ open: "", progress: "", resolved: "" });
    if (boardId) lists.mutate(boardId);
  };

  const discover = useMutation({
    mutationFn: () => api.discoverTracker(provider, access),
    onSuccess: (r) => {
      setError("");
      setWho(r.who);
      setOptions(r.options);
      const first = r.options.find((o) => o.canWrite !== false)?.value ?? r.options[0]?.value ?? "";
      if (provider === "trello") pickBoard(first);
      else setTarget(first);
      setStep(2);
    },
    onError: (err) => setError(failed(err)),
  });

  const connect = useMutation({
    mutationFn: () => {
      const createOn = auto ? ("thread.created" as const) : ("manual" as const);
      return provider === "github"
        ? api.connectTracker(chosen, "github", { repository: target.trim(), token: token.trim(), labels: labels.trim(), createOn })
        : provider === "linear"
          ? api.connectTracker(chosen, "linear", { team: target.trim(), apiKey: token.trim(), createOn })
          : provider === "trello"
            ? api.connectTracker(chosen, "trello", {
                apiKey: trKey.trim(),
                token: token.trim(),
                boardId: target,
                openList: trPick.open,
                progressList: trPick.progress,
                resolvedList: trPick.resolved,
                createOn,
              })
            : api.connectTracker(chosen, "jira", { siteUrl, project: target.trim(), email: email.trim(), apiToken: token.trim(), createOn });
    },
    onSuccess: (r) => {
      setError("");
      setToken("");
      setSecret(r.webhook?.secret ?? null);
      setTrNote(r.webhook?.error ?? "");
      setConnectedSite(chosen);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(`${name} connected`);
      setStep(3);
    },
    onError: (err) => setError(failed(err)),
  });

  const accessReady =
    !!chosen && !!token.trim() && (provider !== "jira" || (!!jiraSite.trim() && !!email.trim())) && (provider !== "trello" || !!trKey.trim());
  const trReady = provider !== "trello" || (!!trPick.open && !!trPick.progress && !!trPick.resolved && new Set([trPick.open, trPick.progress, trPick.resolved]).size === 3);
  const picked = options.find((o) => o.value === target);
  const teamLabel = picked?.label ?? target;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <form
          className="flex min-w-0 flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step === 1 && accessReady) discover.mutate();
            else if (step === 2 && target.trim() && trReady) connect.mutate();
            else if (step === 3) onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Connect a site to {name}</DialogTitle>
            <DialogDescription>
              {step === 1
                ? `Give Snagset access to ${name}. The key is checked now and stored encrypted with this instance's secret key.`
                : step === 2
                  ? `Signed in to ${name}${who ? ` as ${who}` : ""}. Choose where this site's comments go.`
                  : `Connected. Now the way back: a webhook, so that moving an issue in ${name} moves the comment here.`}{" "}
              <Ext href={`${GUIDE}#${provider}`}>Step-by-step guide</Ext>
            </DialogDescription>
          </DialogHeader>
          <Steps at={step} />
          {error && step !== 3 && <Alert>{error}</Alert>}

          {step === 1 && (
            <>
              <Field id="ct-site" label="Site">
                <Picker id="ct-site" value={chosen} onChange={setSite} options={sites.map((s) => ({ value: s.uid, label: s.name }))} />
              </Field>
              <AccessHowTo provider={provider} jiraSite={siteUrl} trelloKey={trKey} />
              {provider === "trello" && (
                <Field id="ct-trello-key" label="API key">
                  <Input id="ct-trello-key" value={trKey} onChange={(e) => setTrKey(e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
              )}
              {provider === "jira" && (
                <>
                  <Field id="ct-jira-site" label="Jira site" hint="The address you open Jira at.">
                    <Input id="ct-jira-site" placeholder="https://kilnwork.atlassian.net" value={jiraSite} onChange={(e) => setJiraSite(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field id="ct-email" label="Account email">
                    <Input id="ct-email" type="email" placeholder="you@kilnwork.studio" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
                  </Field>
                </>
              )}
              <Field id="ct-token" label={provider === "github" || provider === "trello" ? "Token" : provider === "linear" ? "API key" : "API token"}>
                <SecretInput
                  id="ct-token"
                  value={token}
                  onChange={setToken}
                  placeholder={provider === "github" ? "github_pat_…" : provider === "linear" ? "lin_api_…" : ""}
                />
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              {options.length > 0 ? (
                <Field
                  id="ct-target"
                  label={PICK[provider]}
                  hint={
                    picked?.canWrite === false
                      ? "This token can only read that repository: give it Issues › Read and write, or pick another."
                      : provider === "jira"
                        ? "Jira calls these spaces; the key in brackets is the prefix on its issues."
                        : undefined
                  }
                >
                  <Picker
                    id="ct-target"
                    value={target}
                    onChange={provider === "trello" ? pickBoard : setTarget}
                    options={options.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Field>
              ) : (
                <Field
                  id="ct-target"
                  label={PICK[provider]}
                  hint={`${name} listed nothing this key can see. Type it instead: ${provider === "github" ? "owner/name" : "the prefix on its issues, like ENG"}.`}
                >
                  <Input id="ct-target" value={target} onChange={(e) => setTarget(e.target.value)} autoComplete="off" />
                </Field>
              )}
              {provider === "trello" &&
                (lists.isPending ? (
                  <p className="m-0 text-[13px] text-muted-foreground">Reading the board's lists…</p>
                ) : trLists.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    <p className="m-0 text-[13px] text-muted-foreground">
                      A card's list is its status. Moving a card between these three moves the comment here, and back.
                    </p>
                    {(
                      [
                        ["open", "Open"],
                        ["progress", "In progress"],
                        ["resolved", "Resolved"],
                      ] as const
                    ).map(([k, label]) => (
                      <Field key={k} id={`ct-list-${k}`} label={label}>
                        <Picker id={`ct-list-${k}`} value={trPick[k]} onChange={(v) => setTrPick((p) => ({ ...p, [k]: v }))} options={trLists} />
                      </Field>
                    ))}
                    {!trReady && <p className="m-0 text-[12px] text-destructive">Pick three different lists.</p>}
                  </div>
                ) : target ? (
                  <p className="m-0 text-[13px] text-muted-foreground">This board has no open lists. Add three in Trello (for example To do, Doing, Done), then pick it again.</p>
                ) : null)}
              {provider === "github" && (
                <Field id="ct-labels" label="Labels" hint="Optional, comma-separated. Put on every issue Snagset opens.">
                  <Input id="ct-labels" placeholder="review" value={labels} onChange={(e) => setLabels(e.target.value)} autoComplete="off" />
                </Field>
              )}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-[13px]">
                <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                <span>
                  <span className="block font-medium">An issue for every new comment</span>
                  <span className="block text-[12px] text-muted-foreground">
                    Off: you make an issue from a comment's brief when you mean it. On: every new comment opens one.
                  </span>
                </span>
              </label>
            </>
          )}

          {step === 3 && (
            <WayBackStep
              provider={provider}
              site={connectedSite}
              shownSecret={secret}
              onSecret={setSecret}
              target={{
                label: teamLabel,
                ...(provider === "jira" ? { jiraSite: siteUrl } : {}),
                ...(provider === "github" ? { repo: target } : {}),
                ...(provider === "trello" && trNote ? { trelloNote: trNote } : {}),
              }}
            />
          )}

          <DialogFooter>
            {step === 1 && (
              <>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={discover.isPending} disabled={!accessReady}>
                  {discover.isPending ? "Checking…" : "Check access"}
                </Button>
              </>
            )}
            {step === 2 && (
              <>
                <Button type="button" variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button type="submit" loading={connect.isPending} disabled={!target.trim() || !trReady || lists.isPending}>
                  {connect.isPending ? "Connecting…" : "Connect"}
                </Button>
              </>
            )}
            {step === 3 && <Button type="submit">Done</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A connected row's "Webhook…": step 3 alone. */
export function WayBackDialog({
  state,
  onClose,
}: {
  state: { provider: WayBack; site: string; siteName: string; target: { label: string; jiraSite?: string; repo?: string } } | null;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    if (!state) setSecret(null);
  }, [state]);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        {state && (
          <>
            <DialogHeader>
              <DialogTitle>
                {TRACKER_NAME[state.provider]} webhook for {state.siteName}
              </DialogTitle>
              <DialogDescription>
                The way back: moving an issue in {TRACKER_NAME[state.provider]} moves the comment here. <Ext href={`${GUIDE}#${state.provider}`}>Step-by-step guide</Ext>
              </DialogDescription>
            </DialogHeader>
            <WayBackStep provider={state.provider} site={state.site} shownSecret={secret} onSecret={setSecret} target={state.target} />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
