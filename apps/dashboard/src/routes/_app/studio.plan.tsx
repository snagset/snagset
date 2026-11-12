import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { bytes } from "@/components/app/InstanceRows";
import { Spinner } from "@/components/app/Pending";
import { AdminsOnly, PageHeader } from "@/components/app/parts";
import { useMe } from "@/lib/me";
import { q } from "@/lib/query";
import { cn } from "@/lib/utils";

/**
 * Studio › Plan & billing (`SNAGSET_BILLING_URL`). The instance
 * sells nothing: the operator's billing service says what the plans are,
 * which one this studio is on and what each button posts, at
 * `<SNAGSET_BILLING_URL>/state`, and this screen draws it. Every button is a
 * plain form posted to that service, which answers with the store's own page.
 * Usage is the studio's own, from `/me`. Owner-only, as changing the plan is.
 */
const search = z.object({ said: z.string().optional() });

export const Route = createFileRoute("/_app/studio/plan")({
  validateSearch: search,
  loader: () => ({ crumb: "Plan & billing" }),
  component: () => (useMe().user.role === "owner" ? <Plan /> : <AdminsOnly title="Plan & billing" />),
});

interface PlanForm {
  action: string;
  label: string;
  primary: boolean;
  fields: Record<string, string>;
}
interface PlanState {
  /** The plan this studio is on, with when it renews or ends. Optional: an older service sends none. */
  current?: { name: string; price: string; period: string | null; warning: string | null } | null;
  intro?: string;
  /** Shown when a limit is reached: what to do, with the one button. */
  nudge?: { text: string; action: PlanForm } | null;
  footer?: string;
  plans: {
    id: string;
    name: string;
    price: string;
    current: boolean;
    relation?: "current" | "upgrade" | "downgrade";
    /** The rest are optional: an older service sends only the fields above. */
    pitch?: string;
    amount?: string;
    unit?: string;
    yearly?: { amount: string; unit: string; actions: PlanForm[] } | null;
    recommended?: boolean;
    features: string[];
    /** The features this plan adds over the one below it, drawn bold. */
    added?: string[];
    /** Said before a downgrade that would leave sites over the new plan. */
    warning?: string | null;
    actions: PlanForm[];
  }[];
  manage: PlanForm | null;
  notes: string[];
}

function Plan() {
  const me = useMe();
  const { said } = Route.useSearch();
  const setup = useQuery(q.setupState());
  const base = setup.data?.billingUrl ?? null;
  const state = useQuery({
    queryKey: ["plan-state", base] as const,
    enabled: !!base,
    queryFn: async (): Promise<PlanState> => {
      const res = await fetch(`${base!.replace(/\/+$/, "")}/state`, { credentials: "include", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as PlanState;
    },
  });

  const st = state.data;
  const [yearly, setYearly] = useState(false);
  const hasYearly = !!st?.plans.some((p) => p.yearly);
  const cur = st?.plans.find((p) => p.current);
  return (
    <div className="flex flex-col gap-8 p-7">
      <PageHeader title="Plan & billing" sub={me.org.name} />
      {said && (
        <p role="status" className="m-0 max-w-[1040px] rounded-md border border-border bg-card px-3 py-2 text-[13px]">
          {said}
        </p>
      )}
      {setup.isSuccess && !base ? (
        <p className="m-0 text-muted-foreground">This instance has no plans: everything is included.</p>
      ) : state.isError ? (
        <p className="m-0 text-muted-foreground">The plans could not be loaded. Reload to try again.</p>
      ) : !st ? (
        <Spinner />
      ) : (
        <div className="flex max-w-[1040px] flex-col">
          <section aria-label="Your plan" className="grid grid-cols-1 gap-5 rounded-xl border border-border bg-card px-6 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="m-0 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">Your plan</p>
              <p className="m-0 mt-1 text-[28px] font-bold leading-tight">
                {st.current?.name ?? cur?.name}
                <span className="ml-2 text-[15px] font-normal text-muted-foreground">{st.current?.price ?? cur?.price}</span>
              </p>
              {st.current?.period && <p className="m-0 mt-1 text-[13px] text-ink-soft">{st.current.period}</p>}
            </div>
            {st.manage && (
              <div>
                <PostButton base={base!} form={st.manage} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Usage />
            </div>
            {st.current?.warning && (
              <p role="status" className="m-0 rounded-md bg-warn-soft px-3.5 py-2.5 text-[13px] sm:col-span-2">
                {st.current.warning}
              </p>
            )}
            {st.nudge && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-soft px-3.5 py-2.5 sm:col-span-2">
                <p className="m-0 min-w-[220px] flex-1 text-[13px]">{st.nudge.text}</p>
                <PostButton base={base!} form={st.nudge.action} />
              </div>
            )}
          </section>

          <div className="mb-4 mt-9 flex flex-wrap items-center justify-between gap-3">
            <h2 id="compare" className="m-0 text-[17px] font-semibold">
              Compare plans
            </h2>
            {hasYearly && (
              <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-full border border-border bg-card p-0.5">
                {[false, true].map((y) => (
                  <button
                    key={String(y)}
                    type="button"
                    role="radio"
                    aria-checked={yearly === y}
                    onClick={() => setYearly(y)}
                    className={cn("rounded-full px-3.5 py-1 text-[13px]", yearly === y ? "bg-foreground text-background" : "text-ink-soft")}
                  >
                    {y ? (
                      <>
                        Yearly <span className={cn("font-medium", yearly ? "opacity-80" : "text-brand")}>2 months free</span>
                      </>
                    ) : (
                      "Monthly"
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div aria-labelledby="compare" className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {st.plans.map((p) => {
              const y = yearly && p.yearly ? p.yearly : null;
              const actions = y ? y.actions : p.actions;
              const down = p.relation === "downgrade";
              return (
                <div
                  key={p.id}
                  className={cn(
                    "relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5",
                    p.recommended ? "border-brand shadow-[0_0_0_1px_var(--color-brand),0_10px_30px_rgb(61_97_217/.12)]" : "border-border",
                  )}
                >
                  {(p.current || p.recommended) && (
                    <span
                      className={cn(
                        "absolute -top-2.5 left-5 rounded-full px-2.5 py-px text-[11.5px] font-semibold",
                        p.current ? "bg-foreground text-background" : "bg-brand text-white",
                      )}
                    >
                      {p.current ? "Your plan" : "Recommended"}
                    </span>
                  )}
                  <div>
                    <h3 className="m-0 text-[16px] font-semibold">{p.name}</h3>
                    {p.pitch && <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{p.pitch}</p>}
                  </div>
                  <p className="m-0 text-[34px] font-bold leading-none tracking-tight">
                    {y?.amount ?? p.amount ?? p.price}
                    {(y?.unit ?? p.unit) && <span className="ml-1 text-[13px] font-normal tracking-normal text-muted-foreground">{y?.unit ?? p.unit}</span>}
                  </p>
                  <ul className="m-0 flex flex-1 list-none flex-col gap-2 p-0">
                    {p.features.map((f) => (
                      <li key={f} className={cn("flex gap-2 text-[13.5px]", p.added?.includes(f) && "font-semibold")}>
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {p.current ? (
                    <Button type="button" variant="outline" disabled className="w-full">
                      Current plan
                    </Button>
                  ) : down ? (
                    actions.map((a) => <DowngradeLink key={a.label} base={base!} form={a} warning={p.warning ?? null} />)
                  ) : (
                    actions.map((a) => <PostButton key={a.label} base={base!} form={{ ...a, primary: !!p.recommended || a.primary }} wide />)
                  )}
                </div>
              );
            })}
          </div>
          <p className="m-0 mt-5 text-center text-[13px] text-muted-foreground">
            {st.footer ? <b className="font-semibold text-foreground">{st.footer.split(". ")[0]}.</b> : st.intro}{" "}
            {st.footer?.split(". ").slice(1).join(". ")}
          </p>
          {st.notes.length > 0 && <p className="m-0 mt-1.5 text-center text-[12px] text-muted-foreground">{st.notes.join(" ")}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Downgrading is a quiet link, never a button the page pushes. A downgrade
 * that would leave sites over the smaller plan says so first, in place.
 */
function DowngradeLink({ base, form, warning }: { base: string; form: PlanForm; warning: string | null }) {
  const [asking, setAsking] = useState(false);
  if (warning && asking) {
    return (
      <div className="flex flex-col gap-2 rounded-md bg-warn-soft px-3 py-2.5 text-[12.5px]">
        <p className="m-0">{warning}</p>
        <div className="flex items-center gap-3">
          <PostButton base={base} form={{ ...form, label: "Downgrade anyway", primary: false }} />
          <button type="button" className="text-[13px] text-muted-foreground underline underline-offset-2" onClick={() => setAsking(false)}>
            Keep my plan
          </button>
        </div>
      </div>
    );
  }
  return warning ? (
    <button type="button" className="self-center text-[13px] text-muted-foreground underline underline-offset-[3px]" onClick={() => setAsking(true)}>
      {form.label}
    </button>
  ) : (
    <form method="post" action={new URL(form.action, base).toString()} className="m-0 self-center">
      {Object.entries(form.fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className="text-[13px] text-muted-foreground underline underline-offset-[3px]">
        {form.label}
      </button>
    </form>
  );
}

/** A real form post, so the service can answer with the store's page. */
function PostButton({ base, form, wide }: { base: string; form: PlanForm; wide?: boolean }) {
  return (
    <form method="post" action={new URL(form.action, base).toString()} className="m-0">
      {Object.entries(form.fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant={form.primary ? "default" : "outline"} className={wide ? "w-full" : undefined}>
        {form.label}
      </Button>
    </form>
  );
}

function Usage() {
  const { limits } = useMe();
  const rows: { label: string; text: string; share: number | null }[] = [
    { label: "Sites", text: of(limits.projects.used, limits.projects.limit, "site", "sites"), share: share(limits.projects.used, limits.projects.limit) },
    { label: "Members", text: of(limits.members.used, limits.members.limit, "member", "members"), share: share(limits.members.used, limits.members.limit) },
    {
      label: "Screenshots",
      text: !limits.screenshots ? "Not on this plan" : limits.storage.limit === null ? `${bytes(limits.storage.used)} used` : `${bytes(limits.storage.used)} of ${bytes(limits.storage.limit)}`,
      share: limits.screenshots ? share(limits.storage.used, limits.storage.limit) : null,
    },
  ];
  return (
    <dl className="m-0 grid grid-cols-1 gap-5 border-t border-border pt-4 sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-[12px] text-muted-foreground">{r.label}</dt>
          <dd className="m-0 text-[13px]">{r.text}</dd>
          {r.share !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={cn("h-full rounded-full", r.share >= 1 ? "bg-destructive" : "bg-brand")} style={{ width: `${Math.min(100, Math.round(r.share * 100))}%` }} />
            </div>
          )}
        </div>
      ))}
    </dl>
  );
}

const share = (used: number, limit: number | null) => (limit === null || limit === 0 ? null : used / limit);
const of = (used: number, limit: number | null, one: string, many: string) =>
  limit === null ? `${used} ${used === 1 ? one : many}, unlimited` : `${used} of ${limit} ${limit === 1 ? one : many}`;
