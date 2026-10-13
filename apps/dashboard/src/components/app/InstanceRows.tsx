import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { SettingsRow } from "@/components/app/parts";
import { api, ApiFailure, type Instance } from "@/lib/api";
import { ago } from "@/lib/labels";
import { reason } from "@/lib/mutations";
import { q } from "@/lib/query";
import { useMe } from "@/lib/me";

/**
 * Studio › General › the two rows under "This instance": what the
 * instance is connected to, and the rule that keeps a form from fighting an
 * environment. An environment-managed group shows its non-secret parts and
 * says so, with no controls (absent, not disabled — the Members rule). A
 * dashboard-managed one offers Connect, Replace, Disconnect, and for mail a
 * test message. Owners get the controls; admins get the row.
 */
export function InstanceRows({ owner }: { owner: boolean }) {
  const instance = useQuery(q.instance());
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: q.instance().queryKey });
  const [storageOpen, setStorageOpen] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [disconnect, setDisconnect] = useState<"storage" | "mail" | null>(null);
  const disconnectStorage = useMutation({ mutationFn: api.disconnectStorage, onSuccess: () => void refresh(), onError: (e) => toast.error(reason(e)) });
  const disconnectMail = useMutation({ mutationFn: api.disconnectMail, onSuccess: () => void refresh(), onError: (e) => toast.error(reason(e)) });
  const testMail = useMutation({
    mutationFn: api.testMail,
    onSuccess: (r) => toast.success(`Sent to ${r.to}`),
    onError: (e) => toast.error(reason(e)),
  });
  const me = useMe();
  const s = instance.data?.storage;
  const m = instance.data?.mail;

  return (
    <>
      <SettingsRow title="Storage" description="The bucket screenshots and files go to. Without one the widget runs in annotation mode.">
        {!instance.data && <p className="m-0 text-[13px] text-muted-foreground">{instance.isError ? "Could not read it." : "Reading…"}</p>}
        {s && (
          <div className="flex flex-col gap-2">
            <StatusLine
              tone={s.connected ? "ok" : s.unreadable ? "bad" : "off"}
              text={
                s.connected
                  ? `Connected · ${s.bucket} at ${(s.endpoint ?? "").replace(/^https?:\/\//, "")}${s.connectedAt ? ` · since ${ago(s.connectedAt)}` : ""}`
                  : s.unreadable
                    ? "A bucket is stored but its keys will not decrypt — the secret key changed. Connect it again."
                    : "Not connected — annotation mode. Comments and anchors work; screenshots are not offered."
              }
            />
            {me.limits.storage.limit !== null && (
              <p className="m-0 text-[12px] text-muted-foreground">
                {bytes(me.limits.storage.used)} of {bytes(me.limits.storage.limit)} used across the studio's sites.
              </p>
            )}
            {s.source === "env" ? (
              <Managed what="SNAGSET_STORAGE_S3_*" />
            ) : owner ? (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStorageOpen(true)}>
                  {s.connected || s.unreadable ? "Replace…" : "Connect a bucket…"}
                </Button>
                {(s.connected || s.unreadable) && (
                  <Button variant="ghost" size="sm" onClick={() => setDisconnect("storage")}>
                    Disconnect
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </SettingsRow>

      <SettingsRow title="Mail" description="How notifications go out. Without a transport they are off, and the instance says so.">
        {m && (
          <div className="flex flex-col gap-2">
            <StatusLine
              tone={m.configured ? "ok" : m.unreadable ? "bad" : "off"}
              text={
                m.configured
                  ? `${m.scheme === "resend" ? "Resend" : `SMTP · ${m.host ?? ""}`} · from ${m.from}${m.updatedAt ? ` · since ${ago(m.updatedAt)}` : ""}`
                  : m.unreadable
                    ? "A transport is stored but its secret will not decrypt — the secret key changed. Connect it again."
                    : "No transport — notifications are off."
              }
            />
            {m.source === "env" ? (
              <Managed what="SNAGSET_MAIL_URL" />
            ) : owner ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setMailOpen(true)}>
                  {m.configured || m.unreadable ? "Replace…" : "Connect a transport…"}
                </Button>
                {m.configured && (
                  <Button variant="outline" size="sm" loading={testMail.isPending} onClick={() => testMail.mutate()}>
                    {testMail.isPending ? "Sending…" : "Send a test email"}
                  </Button>
                )}
                {(m.configured || m.unreadable) && (
                  <Button variant="ghost" size="sm" onClick={() => setDisconnect("mail")}>
                    Disconnect
                  </Button>
                )}
              </div>
            ) : m.configured && owner === false ? null : null}
          </div>
        )}
      </SettingsRow>

      <ConnectStorage open={storageOpen} onOpenChange={setStorageOpen} onDone={() => void refresh()} />
      <ConnectMail open={mailOpen} onOpenChange={setMailOpen} onDone={() => void refresh()} />
      <ConfirmDialog
        open={disconnect !== null}
        onOpenChange={(o) => !o && setDisconnect(null)}
        title={disconnect === "storage" ? "Disconnect the bucket?" : "Disconnect the mail transport?"}
        description={
          disconnect === "storage"
            ? "Screenshots stop being offered. Nothing in the bucket is deleted, and reconnecting the same bucket brings the pictures back."
            : "Notifications stop going out until a transport is connected again."
        }
        confirmLabel="Disconnect"
        busy={disconnectStorage.isPending || disconnectMail.isPending}
        onConfirm={async () => {
          if (disconnect === "storage") await disconnectStorage.mutateAsync();
          else await disconnectMail.mutateAsync();
          setDisconnect(null);
        }}
      />
    </>
  );
}

function StatusLine({ tone, text }: { tone: "ok" | "off" | "bad"; text: string }) {
  return (
    <p className="m-0 flex items-center gap-2 text-[13px]">
      <span className={`size-2 shrink-0 rounded-full ${tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-destructive" : "bg-line-strong"}`} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function Managed({ what }: { what: string }) {
  return (
    <p className="m-0 text-[12px] text-muted-foreground">
      Set by the environment (<code className="font-mono">{what}</code>). Change it there; the dashboard shows it and does not offer to edit it.
    </p>
  );
}

function ConnectStorage({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [f, setF] = useState({ endpoint: "", bucket: "", region: "", accessKeyId: "", secretAccessKey: "", publicBaseUrl: "" });
  const [error, setError] = useState("");
  const connect = useMutation({ mutationFn: api.connectStorage });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await connect.mutateAsync({
        endpoint: f.endpoint.trim(),
        bucket: f.bucket.trim(),
        accessKeyId: f.accessKeyId.trim(),
        secretAccessKey: f.secretAccessKey,
        ...(f.region.trim() ? { region: f.region.trim() } : {}),
        ...(f.publicBaseUrl.trim() ? { publicBaseUrl: f.publicBaseUrl.trim() } : {}),
      });
      setF({ endpoint: "", bucket: "", region: "", accessKeyId: "", secretAccessKey: "", publicBaseUrl: "" });
      onOpenChange(false);
      onDone();
      toast.success("Bucket connected — screenshots are on");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  const field = (id: keyof typeof f, label: string, placeholder: string, type = "text", hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`st-${id}`}>{label}</Label>
      <Input id={`st-${id}`} type={type} placeholder={placeholder} value={f[id]} onChange={set(id)} autoComplete="off" />
      {hint && <p className="m-0 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a bucket</DialogTitle>
            <DialogDescription>
              Any S3-compatible bucket. It is probed — write, read, delete — before anything is saved, and the keys are
              stored encrypted with this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          {field("endpoint", "Endpoint", "https://ams3.digitaloceanspaces.com")}
          {field("bucket", "Bucket", "snagset")}
          {field("region", "Region", "auto", "text", "Leave empty for providers that do not use one.")}
          {field("accessKeyId", "Access key ID", "")}
          {field("secretAccessKey", "Secret access key", "", "password")}
          {field("publicBaseUrl", "Public base URL", "", "text", "Optional — only if the bucket is served from a CDN address.")}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending}>
              {connect.isPending ? "Probing…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectMail({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState("");
  const connect = useMutation({ mutationFn: api.connectMail });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await connect.mutateAsync({ url: url.trim(), from: from.trim() });
      setUrl("");
      setFrom("");
      onOpenChange(false);
      onDone();
      toast.success("Transport connected — send a test email to be sure");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Could not reach the server.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Connect a mail transport</DialogTitle>
            <DialogDescription>
              Resend is the easy one — the provider owns SPF and DKIM. SMTP works with any provider. The URL is stored
              encrypted with this instance's secret key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mail-url">Transport</Label>
            <Input id="mail-url" type="password" placeholder="resend://re_… or smtp://user:pass@host:587" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mail-from">From</Label>
            <Input id="mail-from" placeholder="Snagset <review@kilnwork.studio>" value={from} onChange={(e) => setFrom(e.target.value)} />
            <p className="m-0 text-[12px] text-muted-foreground">The address every notification is sent from. Resend needs a verified domain for it.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connect.isPending} disabled={!url.trim() || !from.trim()}>
              {connect.isPending ? "Saving…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 1.2 GB, 340 MB, 12 KB — the unit a person reads, one decimal at most. */
function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
