import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { createProject, validateOrigins } from "../projects.ts";
import { LimitReached, planLimitReached, usage, type LimitsSource } from "../plan.ts";
import type { OwnerClaims } from "./owner.ts";
import type { ProjectCache } from "../projectCache.ts";
import { normaliseDomain } from "../domain.ts";
import { inOrg, maintenance } from "../db/scope.ts";
import { effectiveWriteMode } from "./sessions.ts";

/**
 * Adding a site, and the gap that made the dashboard a single-site tool
 * wearing a multi-site UI.
 *
 * The dashboard has had a project switcher (`main.tsx`'s `<select>`
 * over `me.projects`) and **nothing could add a second project**: no route, no
 * dashboard affordance, and `snagset projects` only listed. The switcher had
 * exactly one thing to switch between, forever, and from the outside it looked
 * like a multi-site product. Found by reading the code against a sentence
 * The maintainer wrote — *"a full dashboard which you can add multiple websites to
 * review like pastel does it"* — not by any test, because every test seeded the
 * one project bootstrap makes.
 *
 * ── DASHBOARD-CLASS, AND THAT IS ENFORCED HERE ──
 *
 * No CORS headers, owner cookie required, CSRF pair on the mutation.
 * `requireOwner()` is mounted on this path in `app.ts` and does all three. A
 * reviewer session — which lives on the CLIENT's origin and belongs to whoever
 * opened a link — must never be able to add a site to somebody's org, and the
 * review-link route's own comment records what happens when only CORS stands
 * between `curl` and a write.
 */

type Env = {
  Variables: {
    requestId: string;
    owner?: OwnerClaims;
  };
};
type Ctx = Context<Env>;

export interface SiteDeps {
  /** The org's limits: the site cap is read before a site is added. */
  limits: LimitsSource;
  sql: postgres.Sql;
  /** The finite `open` window. */
  graceHours: number;
  /** The 10-second project cache — invalidated on an edit so the widget's next bootstrap sees it at once. */
  projects?: ProjectCache;
}

/**
 * NO CACHE INVALIDATION HOOK, deliberately.
 *
 * The obvious next line here is "bust the project cache so the new site is live
 * at once", and it would be dead code. A new project was never cached — the
 * cache is a miss and loads it. And `cors.ts`'s origin cache is a self-expiring
 * 10 s window whose own comment already made this call: *"a NEWLY allowed
 * origin waits up to ten seconds to work, which reads as 'it took a moment'"*.
 * A hook that fires and changes nothing is worse than none, because the next
 * person reading it believes invalidation is handled.
 */

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") } }, status as 400);
}

export function siteRoutes(deps: SiteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { sql } = deps;

  /**
   * `POST /api/v1/projects` — add a site.
   *
   * Unscoped, because there is no project to scope it to yet; the ORG comes
   * from the owner cookie and never from the body. A body-supplied `orgId`
   * would be the whole authorisation model, handed to the caller.
   */
  app.post("/api/v1/projects", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
    if (!name) return fail(c, 400, "validation_failed", "A site needs a name.");
    if (name.length > 120) {
      return fail(c, 400, "validation_failed", "That name is too long — 120 characters at most.");
    }

    // Accepts an array or the comma-separated string a text input produces, so
    // the dashboard does not have to split it and the CLI does not have to
    // build an array. One shape on the wire is not worth a parsing rule in two
    // clients.
    const raw = body?.["origins"];
    const origins = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string"
        ? raw.split(",")
        : [];
    try {
      validateOrigins(origins);
    } catch (e) {
      return fail(c, 400, "validation_failed", e instanceof Error ? e.message : String(e));
    }
    // The site's DOMAIN, the one field most sites need: its host, every
    // subdomain, any scheme and port, and localhost. Exact origins stay for
    // the addresses a domain cannot say.
    const rawDomain = body?.["domain"];
    let domain: string | null = null;
    if (typeof rawDomain === "string" && rawDomain.trim()) {
      const r = normaliseDomain(rawDomain);
      if ("error" in r) return fail(c, 400, "validation_failed", r.error);
      domain = r.domain;
    }

    // A site with no allowed origin cannot be talked to by anything — CORS
    // refuses every request from the tag the operator is about to paste. It is
    // ALLOWED (an origin can be added later, and `snagset allow-origin`
    // exists) but the response says so, because the alternative is a tag that
    // is installed correctly and silently does nothing.
    // The plan's number, read before the transaction so the read never waits
    // on a connection the transaction holds. Counted inside it, so two adds in
    // the same second cannot both be the last allowed one.
    const cap = (await deps.limits(owner.orgId)).projects;
    let created: Awaited<ReturnType<typeof createProject>>;
    try {
      created = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
        if (cap !== null) {
          const used = (await usage(tx, owner.orgId)).projects;
          if (used >= cap) throw new LimitReached("projects", cap, used);
        }
        return createProject(tx, {
          orgId: owner.orgId,
          name,
          createdBy: owner.userId,
          origins,
          domain,
          graceHours: deps.graceHours,
        });
      });
    } catch (e) {
      if (e instanceof LimitReached) return planLimitReached(c, e);
      throw e;
    }

    return c.json(
      {
        uid: created.uid,
        name: created.name,
        domain,
        origins: validateOrigins(origins),
        ...(origins.length || domain
          ? {}
          : {
              warning:
                "No origins allowed yet, so no site can talk to this project. " +
                "Add one before pasting the tag.",
            }),
      },
      201,
    );
  });

  /**
   * `POST /api/v1/projects/:uid/origins` — allow another origin.
   *
   * Here rather than in a route file of its own because it is the other half
   * of adding a site: you get it wrong, or you add staging first and
   * production later, and the alternative is the CLI on a machine the person
   * who noticed does not have.
   */
  app.post("/api/v1/projects/:uid/origins", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");

    const [project] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM projects WHERE uid = ${c.req.param("uid")} AND deleted_at IS NULL
    `);
    // A project in another org is reported as absent, not as forbidden — the
    // same rule the comment route follows, so a uid's validity leaks nothing
    // about somebody else's org.
    if (!project || project.org_id !== owner.orgId) {
      return fail(c, 404, "project_not_found", "No project with that uid.");
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const raw = body?.["origin"] ?? body?.["origins"];
    let origins: string[];
    try {
      origins = validateOrigins(
        Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [],
      );
    } catch (e) {
      return fail(c, 400, "validation_failed", e instanceof Error ? e.message : String(e));
    }
    if (!origins.length) return fail(c, 400, "validation_failed", "An origin is required.");

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      for (const origin of origins) {
        // Adding an origin that is already allowed is a no-op, not an error:
        // the operator's intent is satisfied either way, and a 409 here would
        // make "make sure staging is allowed" a two-step operation.
        await tx`
          INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
          VALUES (gen_random_uuid(), ${owner.orgId}, ${project.id}, ${origin}, ${origin.includes("*.")})
          ON CONFLICT (project_id, pattern) DO NOTHING
        `;
      }
    });

    const all = await inOrg(sql, project.org_id, (tx) => tx<{ pattern: string }[]>`
      SELECT pattern FROM project_origins WHERE project_id = ${project.id} ORDER BY pattern
    `);
    return c.json({ origins: all.map((r) => r.pattern) }, 201);
  });

  /**
   * `PATCH /api/v1/projects/:uid` — who sees the toolbar.
   *
   * ONE knob, and it is the knob that already existed: `write_mode`. Who can
   * WRITE is who the toolbar is for — showing a comment bar to somebody whose
   * comments would be refused is a form the product fills in and then tears
   * up. `open` = everyone on the allow-listed addresses sees it and may
   * comment; `link-required` = only somebody who opened a review link (and,
   * thereafter, whenever they come back).
   *
   * Choosing `open` here CLEARS the grace timer. The 24-hour downgrade
   * exists so a site somebody set up and forgot does not stay a public comment
   * box; an owner choosing "everyone" in the dashboard is the opposite of
   * forgetting, and having the toolbar silently vanish a day later would be
   * this product's most mysterious bug report.
   */
  app.patch("/api/v1/projects/:uid", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const [project] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string; domain: string | null }[]>`
      SELECT id, org_id, settings->>'domain' AS domain
      FROM projects WHERE uid = ${c.req.param("uid")} AND deleted_at IS NULL
    `);
    if (!project || project.org_id !== owner.orgId) {
      return fail(c, 404, "project_not_found", "No project with that uid.");
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    /**
     * THREE FIELDS NOW, NOT ONE. Mounted this route for `writeMode` alone,
     * and a site was create-once ever after: a typo in the name was permanent
     * and a staging URL that moved could only be ADDED to, never corrected.
     * The maintainer, using it: *"the sites we should be able to edit the url and name
     * and delete or edit it, right now is just one time."*
     *
     * Each is optional and absent means unchanged, so the existing
     * `{ writeMode }` callers keep working unaltered.
     */
    const mode = body?.["writeMode"];
    const rawName = body?.["name"];
    const rawOrigins = body?.["origins"];
    const rawDomain = body?.["domain"];
    const rawStatus = body?.["status"];
    const rawGuests = body?.["guestsCanChangeStatus"];
    if (
      mode === undefined &&
      rawName === undefined &&
      rawOrigins === undefined &&
      rawDomain === undefined &&
      rawStatus === undefined &&
      rawGuests === undefined
    ) {
      return fail(
        c,
        400,
        "validation_failed",
        "Send at least one of name, origins, domain, status, writeMode or guestsCanChangeStatus.",
      );
    }
    if (mode !== undefined && mode !== "open" && mode !== "link-required" && mode !== "verified-only") {
      return fail(c, 400, "validation_failed", "writeMode must be open, link-required or verified-only.");
    }

    let name: string | undefined;
    if (rawName !== undefined) {
      name = String(rawName).trim();
      if (!name) return fail(c, 400, "validation_failed", "A site needs a name.");
      if (name.length > 120) {
        return fail(c, 400, "validation_failed", "That name is longer than 120 characters.");
      }
    }

    // The domain: a string to set, null (or empty) to clear.
    let domain: string | null | undefined;
    if (rawDomain !== undefined) {
      if (rawDomain === null || (typeof rawDomain === "string" && !rawDomain.trim())) {
        domain = null;
      } else if (typeof rawDomain === "string") {
        const r = normaliseDomain(rawDomain);
        if ("error" in r) return fail(c, 400, "validation_failed", r.error);
        domain = r.domain;
      } else {
        return fail(c, 400, "validation_failed", "domain must be a string, or null to clear it.");
      }
    }
    // The switch, layer 6's kill switch with a dashboard
    // control: paused refuses the widget's writes and hides the toolbar;
    // reads and the studio's own triage go on.
    let status: "active" | "paused" | undefined;
    if (rawStatus !== undefined) {
      if (rawStatus !== "active" && rawStatus !== "paused") {
        return fail(c, 400, "validation_failed", "status must be active or paused.");
      }
      status = rawStatus;
    }

    /**
     * Whether guests may change a comment's status. Who may do what on
     * the site is the same register as rounds' rename and archive, so the
     * same roles: an owner or an admin. The other fields keep the route's
     * existing gate (any member of the studio).
     */
    let guests: boolean | undefined;
    if (rawGuests !== undefined) {
      if (typeof rawGuests !== "boolean") {
        return fail(c, 400, "validation_failed", "guestsCanChangeStatus must be true or false.");
      }
      if (owner.role !== "owner" && owner.role !== "admin") {
        return fail(c, 403, "forbidden", "Only an owner or an admin can change what guests may do.");
      }
      guests = rawGuests;
    }

    /**
     * Origins are REPLACED, not merged, because this is an edit form and the
     * only way to correct a wrong one is to be able to remove it. `POST
     * /origins` keeps its additive shape for the add-one case.
     */
    let origins: string[] | undefined;
    if (rawOrigins !== undefined) {
      try {
        origins = validateOrigins(
          Array.isArray(rawOrigins)
            ? rawOrigins.map(String)
            : typeof rawOrigins === "string"
              ? rawOrigins.split(",")
              : [],
        );
      } catch (e) {
        return fail(c, 400, "validation_failed", e instanceof Error ? e.message : String(e));
      }
      if (!origins.length && !(domain === undefined ? project.domain : domain)) {
        // A site with neither a domain nor an address accepts nothing from
        // anywhere, which is a confusing way to discover you have switched
        // your own widget off. (The switch is `status`, one field down.)
        return fail(c, 400, "validation_failed", "A site needs a domain or at least one address.");
      }
    }
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      await tx`
        UPDATE projects
           SET name = ${name === undefined ? tx`name` : tx`${name}`},
               status = ${status === undefined ? tx`status` : tx`${status}::snag_project_status`},
               paused_reason = ${status === undefined ? tx`paused_reason` : status === "paused" ? tx`'dashboard'` : tx`NULL`},
               settings = ${
                 domain === undefined
                   ? tx`settings`
                   : domain === null
                     ? tx`settings - 'domain'`
                     : tx`settings || jsonb_build_object('domain', ${domain}::text)`
               },
               write_mode = ${mode === undefined ? tx`write_mode` : tx`${mode}::snag_write_mode`},
               guest_can_resolve = ${guests === undefined ? tx`guest_can_resolve` : tx`${guests}`},
               write_mode_downgrade_at = ${
                 mode === undefined
                   ? tx`write_mode_downgrade_at`
                   : mode === "open"
                     ? null
                     : tx`write_mode_downgrade_at`
               }
               -- No config_version bump. It fed the x-snagset-config-version
               -- header, which no client ever read; both are retired and the
               -- column went in 0013.
         WHERE id = ${project.id}::uuid
      `;
      if (origins) {
        // Replace, in one transaction, so a site is never briefly origin-less
        // — which would refuse every write from its own staging URL.
        await tx`DELETE FROM project_origins WHERE project_id = ${project.id}::uuid`;
        for (const origin of origins) {
          await tx`
            INSERT INTO project_origins (id, org_id, project_id, pattern, is_wildcard)
            VALUES (gen_random_uuid(), ${owner.orgId}, ${project.id}, ${origin}, ${origin.includes("*.")})
          `;
        }
      }
    });
    // The bootstrap reads the project through the 10-second cache; an edit
    // made on the dashboard should be true on the next page load, not the
    // one after.
    deps.projects?.invalidate(c.req.param("uid"));
    const [row] = await inOrg(sql, project.org_id, (tx) => tx<{ name: string; write_mode: string; write_mode_downgrade_at: Date | null; status: string; domain: string | null; guest_can_resolve: boolean }[]>`
      SELECT name, write_mode, write_mode_downgrade_at, status, settings->>'domain' AS domain, guest_can_resolve
      FROM projects WHERE id = ${project.id}::uuid
    `);
    const all = await inOrg(sql, project.org_id, (tx) => tx<{ pattern: string }[]>`
      SELECT pattern FROM project_origins WHERE project_id = ${project.id}::uuid ORDER BY pattern
    `);
    return c.json({
      uid: c.req.param("uid"),
      name: row?.name,
      // What the widget enforces, as the sites list says it.
      writeMode: row ? effectiveWriteMode(row, new Date()) : undefined,
      status: row?.status,
      domain: row?.domain ?? null,
      guestsCanChangeStatus: row?.guest_can_resolve,
      origins: all.map((r) => r.pattern),
    });
  });

  /**
   * `DELETE /api/v1/projects/{uid}` — SOFT, and that is the whole design.
   *
   * A site holds a client's words. `deleted_at` has been on the row since
   * `0001` and every read already filters on it, so this is the delete the
   * schema was built for: the site stops appearing, its widget stops being
   * served, and nothing a reviewer wrote is destroyed. An operator who deletes
   * the wrong site has a database row to restore rather than an apology to
   * write.
   *
   * The name is freed for reuse, because a studio that deletes "Kilnwork" and
   * makes a new "Kilnwork" is doing something ordinary — and `uid` is what
   * anything durable actually points at.
   */
  app.delete("/api/v1/projects/:uid", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const [project] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM projects WHERE uid = ${c.req.param("uid")} AND deleted_at IS NULL
    `);
    if (!project || project.org_id !== owner.orgId) {
      return fail(c, 404, "project_not_found", "No project with that uid.");
    }
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${owner.orgId}, true)`;
      await tx`
        UPDATE projects SET deleted_at = now()
         WHERE id = ${project.id}::uuid
      `;
    });
    return c.body(null, 204);
  });

  /** The origins on a site — what the dashboard shows beside the script tag. */
  app.get("/api/v1/projects/:uid/origins", async (c) => {
    const owner = c.get("owner");
    if (!owner) return fail(c, 401, "unauthorized", "Sign in to the dashboard first.");
    const [project] = await maintenance(sql, (tx) => tx<{ id: string; org_id: string; domain: string | null }[]>`
      SELECT id, org_id, settings->>'domain' AS domain
      FROM projects WHERE uid = ${c.req.param("uid")} AND deleted_at IS NULL
    `);
    if (!project || project.org_id !== owner.orgId) {
      return fail(c, 404, "project_not_found", "No project with that uid.");
    }
    const all = await inOrg(sql, project.org_id, (tx) => tx<{ pattern: string }[]>`
      SELECT pattern FROM project_origins WHERE project_id = ${project.id} ORDER BY pattern
    `);
    // Where the widget may run is the domain AND the exact addresses.
    return c.json({ domain: project.domain, origins: all.map((r) => r.pattern) });
  });

  return app;
}
