import { useState, type ReactNode } from "react";
import { Link, useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BlocksIcon,
  BookOpenIcon,
  Building2Icon,
  ChevronsUpDownIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  ActivityIcon,
  LayoutGridIcon,
  SearchIcon,
  LogOutIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mark } from "./Mark";
import { api, type Me } from "@/lib/api";
import { rememberAuth } from "@/lib/auth";
import { initials } from "@/lib/labels";
import { Palette, usePalette } from "@/components/app/Palette";
import { useMe } from "@/lib/me";
import { q } from "@/lib/query";
import { useCurrentSite, type Site } from "@/lib/site";
import { readTheme, setTheme, type Theme } from "@/lib/theme";
import { checkForUpdate, type UpdateResult } from "@/lib/update";

// The public site, not the repository: the repository is private, and a
// Docs link that lands on a GitHub sign-in is worse than no link.
const DOCS_URL = "https://snagset.com/docs/";
const RELEASES_URL = "https://www.npmjs.com/package/@snagset/server?activeTab=versions";
const UPGRADE_URL = "https://snagset.com/docs/self-hosting/#upgrade";

/**
 * The shell: a sidebar with every destination visible, a header that
 * carries only the crumb. Rendered once at the `_app` route; only the outlet
 * changes on navigation (rule 5).
 */
export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const site = useCurrentSite(me);
  const [palette, setPalette] = usePalette();
  return (
    <SidebarProvider>
      <AppSidebar me={me} site={site} />
      <SidebarInset className="min-w-0">
        <Header onSearch={() => setPalette(true)} />
        <DatabaseBehind names={me.pendingMigrations ?? []} owner={me.user.role === "owner"} />
        <div className="min-h-0 flex-1">{children}</div>
      </SidebarInset>
      {/* ⌘K from anywhere signed in, including the screens with no search box of their own. */}
      <Palette open={palette} onOpenChange={setPalette} />
    </SidebarProvider>
  );
}

/**
 * The database is behind this build. On a serverless deploy nothing migrates
 * by itself (db/migrate.ts on the server says why), and the first symptom of a
 * forgotten `snagset migrate` would otherwise be a job failing in the night.
 * Above every page, because a half-upgraded instance is the studio's problem
 * wherever it is looking. The owner gets the command; anyone else, who to ask.
 */
function DatabaseBehind({ names, owner }: { names: string[]; owner: boolean }) {
  if (!names.length) return null;
  return (
    <div role="alert" className="mx-7 mt-4 rounded-md border border-destructive/40 bg-warn-soft px-3 py-2 text-[13px] text-destructive">
      <p className="m-0 font-medium">
        The database needs an update for this version ({names.length} {names.length === 1 ? "migration" : "migrations"}).
      </p>
      <p className="m-0 mt-0.5">
        {owner ? (
          <>
            Run <code className="font-mono">snagset migrate</code> with this instance's <code className="font-mono">DATABASE_URL</code> — from
            the project, <code className="font-mono">pnpm migrate</code>. Until then, parts of this version may fail.
          </>
        ) : (
          "Ask the studio's owner to run snagset migrate. Until then, parts of this version may fail."
        )}
      </p>
    </div>
  );
}

function AppSidebar({ me, site }: { me: Me; site: Site | null }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const on = (prefix: string) => path === prefix || path.startsWith(prefix + "/");
  return (
    <Sidebar>
      <SidebarHeader className="px-3 pb-1 pt-3">
        <StudioHeader me={me} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SiteSwitcher me={me} site={site} />
          {site && (
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={on(`/s/${site.uid}/comments`)}
                    render={<Link to="/s/$site/comments" params={{ site: site.uid }} />}
                  >
                    <MessageSquareIcon />
                    <span>Comments</span>
                  </SidebarMenuButton>
                  {site.unresolved > 0 && <SidebarMenuBadge>{site.unresolved}</SidebarMenuBadge>}
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={on(`/s/${site.uid}/reviewers`)}
                    render={<Link to="/s/$site/reviewers" params={{ site: site.uid }} />}
                  >
                    <UsersIcon />
                    <span>Reviewers</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={on(`/s/${site.uid}/settings`)}
                    render={<Link to="/s/$site/settings" params={{ site: site.uid }} />}
                  >
                    <SlidersHorizontalIcon />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          )}
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Studio</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={on("/sites")} render={<Link to="/sites" />}>
                  <LayoutGridIcon />
                  <span>Sites</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={on("/activity")} render={<Link to="/activity" />}>
                  <ActivityIcon />
                  <span>Activity</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={on("/studio/members")} render={<Link to="/studio/members" />}>
                  <UsersIcon />
                  <span>Members</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={on("/studio/integrations")} render={<Link to="/studio/integrations" />}>
                  <BlocksIcon />
                  <span>Integrations</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={path === "/studio"} render={<Link to="/studio" />}>
                  <Building2Icon />
                  <span>General</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
              <BookOpenIcon />
              <span>Docs</span>
              <ExternalLinkIcon className="ml-auto size-3.5 text-muted-foreground" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <HelpMenu />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountMenu me={me} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/** The Site group's label IS the switcher. */
/**
 * The studio's name, top left. One studio and no way to make another: a link
 * to its settings, as it always was. Two studios, or an instance that lets
 * this person make one: the same block opens a menu — every studio
 * they belong to, the current one marked, and "New studio…" where it is
 * offered. Switching moves the session, so the cache goes with it.
 */
function StudioHeader({ me }: { me: Me }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const block = (
    <>
      <Mark size={20} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[14px] font-semibold leading-tight tracking-tight">{me.org.name}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">{location.host}</span>
      </span>
    </>
  );
  if (me.orgs.length <= 1 && !me.signupOpen) {
    return (
      <Link to="/studio" className="flex items-center gap-2.5 rounded-md px-1 py-0.5 text-foreground hover:bg-sidebar-accent" aria-label={`${me.org.name} — studio settings`}>
        {block}
      </Link>
    );
  }
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      // The cookies moved to another studio: nothing cached is this one's.
      qc.clear();
      setMaking(false);
      setName("");
      void navigate({ to: "/sites", replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button type="button" className="flex w-full items-center gap-2.5 rounded-md px-1 py-0.5 text-foreground hover:bg-sidebar-accent" aria-label="Switch studio" />}
        >
          {block}
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Studios</DropdownMenuLabel>
            {me.orgs.map((o) => (
              <DropdownMenuItem key={o.slug} disabled={o.current} onClick={() => void go(() => api.switchOrg(o.slug))}>
                <Building2Icon />
                <span className="truncate">{o.name}</span>
                {o.current && <span className="ml-auto text-[11px] text-muted-foreground">current</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void navigate({ to: "/studio" })}>
            <SlidersHorizontalIcon />
            Studio settings
          </DropdownMenuItem>
          {me.signupOpen && (
            <DropdownMenuItem onClick={() => setMaking(true)}>
              <PlusIcon />
              New studio…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={making} onOpenChange={(o) => !busy && setMaking(o)}>
        <DialogContent className="sm:max-w-[420px]">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void go(() => api.createOrg(name.trim() || "My studio"));
            }}
          >
            <DialogHeader>
              <DialogTitle>New studio</DialogTitle>
              <DialogDescription>Its own sites, members and settings. You are its owner, and you move to it now — this one stays in the menu.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-studio-name">Studio name</Label>
              <Input id="new-studio-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My studio" autoFocus />
            </div>
            {error && <p className="m-0 text-[12px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMaking(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                {busy ? "Creating…" : "Create studio"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SiteSwitcher({ me, site }: { me: Me; site: Site | null }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="mb-1 flex h-[34px] w-full items-center justify-between rounded-md border border-border bg-card px-2.5 text-[13px] font-semibold text-foreground"
            aria-label="Switch site"
          />
        }
      >
        <span className="truncate">{site?.name ?? "No sites yet"}</span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        {/* A label lives inside a group in this generation of the kit — outside one it throws. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sites</DropdownMenuLabel>
          {me.projects.map((p) => (
            <DropdownMenuItem
              key={p.uid}
              onClick={() => void navigate({ to: "/s/$site/comments", params: { site: p.uid } })}
            >
              <LayoutGridIcon />
              <span className="truncate">{p.name}</span>
              {p.uid === site?.uid && <span className="ml-auto text-[11px] text-muted-foreground">current</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate({ to: "/sites", search: { add: true } })}>
          <PlusIcon />
          Add a site
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void navigate({ to: "/sites" })}>
          <LayoutGridIcon />
          All sites
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HelpMenu() {
  const meta = useQuery(q.meta());
  const version = meta.data?.version ?? "";
  const [update, setUpdate] = useState<{ state: "idle" | "checking" | "done" | "failed"; result?: UpdateResult }>({
    state: "idle",
  });
  const check = async () => {
    setUpdate({ state: "checking" });
    try {
      setUpdate({ state: "done", result: await checkForUpdate(version) });
    } catch {
      setUpdate({ state: "failed" });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton />}>
        <CircleHelpIcon />
        <span>Help</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-[240px]">
        <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
          <BookOpenIcon />
          Docs
          <ExternalLinkIcon className="ml-auto size-3 text-muted-foreground" />
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={RELEASES_URL} target="_blank" rel="noreferrer" />}>
          Changelog
          <ExternalLinkIcon className="ml-auto size-3 text-muted-foreground" />
        </DropdownMenuItem>
        {meta.data?.sourceUrl && (
          <DropdownMenuItem render={<a href={meta.data.sourceUrl} target="_blank" rel="noreferrer" />}>
            Source · AGPL
            <ExternalLinkIcon className="ml-auto size-3 text-muted-foreground" />
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
          Snagset {version || "—"}
          {update.state === "idle" && (
            <>
              {" · "}
              <button type="button" className="text-brand hover:underline" onClick={() => void check()}>
                Check for updates
              </button>
            </>
          )}
          {update.state === "checking" && " · checking…"}
          {update.state === "failed" && " · could not reach npm"}
          {update.state === "done" && update.result && (
            <>
              {" · "}
              {update.result.newer ? (
                <a href={UPGRADE_URL} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  {update.result.latest} is out — how to upgrade
                </a>
              ) : (
                "up to date"
              )}
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountMenu({ me }: { me: Me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [theme, setThemeState] = useState<Theme>(readTheme);
  // An account with no name yet is introduced by its email, once — the second
  // line then carries the role rather than repeating the address.
  const name = me.user.name || me.user.email;
  const second = me.user.name ? me.user.email : me.user.role;
  const signOut = async () => {
    await api.logout().catch(() => {});
    rememberAuth("out");
    queryClient.clear();
    void navigate({ to: "/sign-in", replace: true });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
        <Avatar className="size-8 rounded-full">
          <AvatarFallback className="bg-primary text-[12px] font-semibold text-primary-foreground">
            {initials(me.user.name, me.user.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 text-left leading-tight">
          <div className="truncate text-[13px] font-semibold">{name}</div>
          <div className="truncate text-[11.5px] text-muted-foreground">{second}</div>
        </div>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-[250px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col">
            <span className="text-[13px] font-semibold">{name}</span>
            <span className="text-[11.5px] font-normal text-muted-foreground">
              {me.user.name ? `${me.user.email} · ${me.user.role}` : me.user.role}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => {
            const t = v as Theme;
            setTheme(t);
            setThemeState(t);
          }}
        >
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate({ to: "/you" })}>
          <UserIcon />
          You
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The crumb, from each matched route's loader (`{ crumb }`). Nothing else. */
function Header({ onSearch }: { onSearch: () => void }) {
  const matches = useMatches();
  const crumbs = matches
    .map((m) => (m.loaderData as { crumb?: string } | undefined)?.crumb)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-4">
      <SidebarTrigger className="-ml-1" />
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13.5px] font-medium text-muted-foreground">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-line-strong">/</span>}
            <span className={i === crumbs.length - 1 ? "text-foreground" : undefined}>{c}</span>
          </span>
        ))}
      </nav>
      <div className="flex-1" />
      {/* The palette is a chord, and a chord nobody is told about is a chord
          nobody uses — so the shortcut is drawn as a control that also works. */}
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search and go"
        className="flex h-7 items-center gap-2 rounded-md border border-border bg-card px-2 text-[12.5px] text-muted-foreground"
      >
        <SearchIcon className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-border px-1 font-mono text-[11px] sm:inline">⌘K</kbd>
      </button>
    </div>
  );
}
