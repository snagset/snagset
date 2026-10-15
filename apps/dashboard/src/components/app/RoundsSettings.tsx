import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { SettingsRow } from "@/components/app/parts";
import type { Round } from "@/lib/api";
import { useMe } from "@/lib/me";
import { q } from "@/lib/query";
import { useDeleteRound, useEditRound } from "@/lib/threads";

/**
 * A site's rounds, managed. Rounds run side by side, so the list is
 * where a studio tidies them: rename, close and reopen, archive and restore,
 * delete. The round MENU on Comments stays the place to switch and to start
 * one; this is the place to reshape them.
 *
 * Archive puts a round away (gone from the widget and the menu, every comment
 * kept); delete takes its comments with it, after the name is typed. The last
 * open round cannot be closed, archived or deleted — the server refuses it,
 * and the buttons say why before anyone asks.
 */
export function RoundsSettings({ uid }: { uid: string }) {
  const me = useMe();
  const rounds = useQuery(q.rounds(uid));
  const manager = me.user.role === "owner" || me.user.role === "admin";
  const list = rounds.data?.data ?? [];
  const live = list.filter((r) => !r.closed && !r.archived).length;

  return (
    <SettingsRow
      title="Rounds"
      description={
        <>
          One pass of feedback each, and several can run at once — your own QA beside the client's. A new comment goes to
          the round its reviewer is looking at. Archive a finished round to put it away; delete removes its comments too.
        </>
      }
    >
      {!manager && <p className="m-0 text-[12.5px] text-muted-foreground">Only an owner or an admin can change rounds.</p>}
      <ul className="m-0 flex list-none flex-col divide-y divide-border p-0" aria-label="Rounds">
        {list.map((r) => (
          <RoundRow key={r.id} uid={uid} round={r} manager={manager} last={!r.closed && !r.archived && live === 1} />
        ))}
        {rounds.isSuccess && list.length === 0 && <li className="text-[12.5px] text-muted-foreground">No rounds yet.</li>}
      </ul>
    </SettingsRow>
  );
}

const LAST = "Open another round first — new comments need somewhere to go.";

function RoundRow({ uid, round: r, manager, last }: { uid: string; round: Round; manager: boolean; last: boolean }) {
  const edit = useEditRound(uid);
  const del = useDeleteRound(uid);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(r.name);
  const [confirming, setConfirming] = useState(false);
  const status = r.archived ? "archived" : r.closed ? "closed" : "open";
  const busy = edit.isPending || del.isPending;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      {naming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = name.trim();
            if (!v || v === r.name) return setNaming(false);
            edit.mutate({ id: r.id, name: v }, { onSuccess: () => setNaming(false) });
          }}
        >
          <Input
            aria-label={`New name for ${r.name}`}
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
          />
          <Button type="submit" size="sm" disabled={!name.trim() || edit.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{r.name}</span>
            <Badge variant="outline" className="text-[11px]">
              {status}
            </Badge>
          </div>
          <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
            Round {r.number} · {r.threads} {r.threads === 1 ? "comment" : "comments"}
            {r.unresolved > 0 ? ` · ${r.unresolved} unresolved` : ""}
          </p>
        </div>
      )}
      {manager && !naming && (
        <div className="flex flex-wrap items-center gap-1" title={last ? LAST : undefined}>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Rename ${r.name}`}
            disabled={busy}
            onClick={() => {
              setName(r.name);
              setNaming(true);
            }}
          >
            Rename
          </Button>
          {!r.archived && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${r.closed ? "Reopen" : "Close"} ${r.name}`}
              disabled={busy || last}
              onClick={() => edit.mutate({ id: r.id, closed: !r.closed })}
            >
              {r.closed ? "Reopen" : "Close"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${r.archived ? "Restore" : "Archive"} ${r.name}`}
            disabled={busy || last}
            onClick={() => edit.mutate({ id: r.id, archived: !r.archived })}
          >
            {r.archived ? "Restore" : "Archive"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            aria-label={`Delete ${r.name}`}
            disabled={busy || last}
            onClick={() => setConfirming(true)}
          >
            Delete…
          </Button>
        </div>
      )}
      {manager && last && !naming && <p className="m-0 w-full text-[12px] text-muted-foreground">{LAST}</p>}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${r.name}?`}
        description={
          r.threads > 0 ? (
            <>
              This deletes the round and{" "}
              <b className="font-semibold text-foreground">
                {r.threads} {r.threads === 1 ? "comment" : "comments"} and their screenshots
              </b>
              . Reviewers stop seeing them straight away. To keep them out of sight instead, archive the round.
            </>
          ) : (
            <>This round has no comments. Its number, Round {r.number}, is not used again.</>
          )
        }
        confirmLabel="Delete round"
        confirmWord={r.name}
        busy={del.isPending}
        onConfirm={() => del.mutate({ id: r.id, confirm: r.name }, { onSuccess: () => setConfirming(false) })}
      />
    </li>
  );
}
