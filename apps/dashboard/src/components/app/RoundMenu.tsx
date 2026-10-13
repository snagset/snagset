import { useState } from "react";
import { ChevronDownIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Round } from "@/lib/api";

/**
 * THE ROUND, here and nowhere else — it governs the Comments list and nothing
 * else on the site. One pill, one menu: switch, or start the next, which is
 * how a round closes; the server closes the previous one in the same
 * statement, so there is no separate "close".
 */
export function RoundMenu({
  rounds,
  active,
  onPick,
  onStart,
  starting,
}: {
  rounds: Round[];
  active: number;
  onPick: (n: number) => void;
  onStart: (name: string) => void;
  starting: boolean;
}) {
  const cur = rounds.find((r) => r.number === active);
  const next = (rounds[0]?.number ?? 0) + 1;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-muted px-2.5 text-[12.5px] font-semibold text-foreground"
              aria-label="Round"
            />
          }
        >
          <RotateCwIcon className="size-3.5" />
          {cur?.name ?? `Round ${active}`}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[260px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Rounds</DropdownMenuLabel>
            {rounds.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => onPick(r.number)}>
                <span className="truncate">{r.name}</span>
                <span className="ml-auto text-[11.5px] text-muted-foreground">
                  {r.closed ? "closed" : "open"}
                  {r.unresolved > 0 ? ` · ${r.unresolved} to go` : ""}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setName(`Round ${next}`);
              setNaming(true);
            }}
          >
            Start a new round…
            <span className="ml-auto text-[11.5px] text-muted-foreground">closes this one</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {cur && (
        <span className="text-[12px] text-muted-foreground">
          {cur.closed ? "closed" : "open"}
          {cur.unresolved > 0 ? ` · ${cur.unresolved} to go` : cur.closed ? "" : " · all clear"}
        </span>
      )}
      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || starting) return;
              onStart(name.trim());
              setNaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Start a new round</DialogTitle>
              <DialogDescription>
                A round is one pass of feedback. Starting the next one closes {cur?.name ?? "the current one"}; what is
                still open there stays counted, not carried over.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="round-name">Name</Label>
              <Input id="round-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || starting}>
                {starting ? "Starting…" : "Start the round"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
