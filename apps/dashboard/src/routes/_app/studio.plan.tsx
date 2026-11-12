import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { bytes } from "@/components/app/InstanceRows";
import { Spinner } from "@/components/app/Pending";
import { AdminsOnly, PageHeader, SettingsRow } from "@/components/app/parts";
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
  intro?: string;
  plans: { id: string; name: string; price: string; current: boolean; features: string[]; actions: PlanForm[] }[];
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

  return (
    <div className="flex flex-col gap-10 p-7">
      <PageHeader title="Plan & billing" sub={me.org.name} />
      {said && (
        <p role="status" className="m-0 max-w-[1040px] rounded-md border border-border bg-card px-3 py-2 text-[13px]">
          {said}
        </p>
      )}
      <SettingsRow title="Usage" description="What this studio uses, against its plan.">
        <Usage />
      </SettingsRow>
      {setup.isSuccess && !base ? (
        <p className="m-0 text-muted-foreground">This instance has no plans: everything is included.</p>
      ) : state.isError ? (
        <p className="m-0 text-muted-foreground">The plans could not be loaded. Reload to try again.</p>
      ) : !state.data ? (
        <Spinner />
      ) : (
        <section className="flex max-w-[1040px] flex-col gap-4">
          {state.data.intro && <p className="m-0 text-muted-foreground">{state.data.intro}</p>}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {state.data.plans.map((p) => (
              <div
                key={p.id}
                className={cn(
                  "flex min-w-0 flex-col gap-2 rounded-lg border bg-card px-4 py-3.5",
                  p.current ? "border-brand ring-1 ring-brand" : "border-border",
                )}
              >
                <h2 className="m-0 flex items-center gap-2 text-[14px] font-semibold">
                  {p.name}
                  {p.current && <span className="rounded-full bg-brand-soft px-2 py-px text-[11.5px] font-medium text-brand">Current</span>}
                </h2>
                <span className="text-[13px] text-muted-foreground">{p.price}</span>
                <ul className="m-0 flex-1 list-disc pl-4 text-[12.5px] text-muted-foreground">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {p.actions.map((a) => (
                  <PostButton key={a.label} base={base!} form={a} />
                ))}
              </div>
            ))}
          </div>
          {state.data.manage && (
            <div>
              <PostButton base={base!} form={state.data.manage} />
            </div>
          )}
          {state.data.notes.map((n) => (
            <p key={n} className="m-0 text-[12.5px] text-muted-foreground">
              {n}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

/** A real form post, so the service can answer with the store's page. */
function PostButton({ base, form }: { base: string; form: PlanForm }) {
  return (
    <form method="post" action={new URL(form.action, base).toString()} className="m-0">
      {Object.entries(form.fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant={form.primary ? "default" : "outline"} className={form.primary ? "w-full" : undefined}>
        {form.label}
      </Button>
    </form>
  );
}

function Usage() {
  const { limits } = useMe();
  const of = (used: number, limit: number | null, one: string, many: string) =>
    limit === null ? `${used} ${used === 1 ? one : many}, unlimited` : `${used} of ${limit} ${limit === 1 ? one : many}`;
  return (
    <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      <dt className="text-muted-foreground">Sites</dt>
      <dd className="m-0">{of(limits.projects.used, limits.projects.limit, "site", "sites")}</dd>
      <dt className="text-muted-foreground">Members</dt>
      <dd className="m-0">{of(limits.members.used, limits.members.limit, "member", "members")}</dd>
      <dt className="text-muted-foreground">Screenshots</dt>
      <dd className="m-0">
        {!limits.screenshots ? "Not on this plan" : limits.storage.limit === null ? `${bytes(limits.storage.used)} used` : `${bytes(limits.storage.used)} of ${bytes(limits.storage.limit)}`}
      </dd>
    </dl>
  );
}
