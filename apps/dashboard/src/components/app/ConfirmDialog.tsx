import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CheckIcon, CopyIcon } from "lucide-react";

/**
 * A confirmation — the tiers. Tier one bolds the thing in the description;
 * tier two (`confirmWord`) is the GitHub / Vercel pattern: the button stays
 * disabled until the person has typed the thing they are about to lose.
 * Typing a name is not friction for its own sake; it is the one act that
 * proves you read which one.
 *
 * `busy` locks the dialog: a delete that has left the building cannot be
 * un-asked by closing the box it was asked in.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  confirmWord,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  /** Exact text the person must type before the confirm button enables. */
  confirmWord?: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const armed = !confirmWord || typed.trim() === confirmWord;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={false}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (armed && !busy) onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {confirmWord && (
            <div className="flex flex-col gap-1.5">
              {/* The name is a button: one click copies it and puts the cursor
                  in the box, so the person pastes what they have just read
                  rather than retyping a long name. It is still their act. */}
              <p className="m-0 flex flex-wrap items-center gap-1 text-sm font-medium">
                Type
                <button
                  type="button"
                  disabled={busy}
                  title="Copy the name"
                  className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-semibold text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    void navigator.clipboard?.writeText(confirmWord).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                    document.getElementById(id)?.focus();
                  }}
                >
                  {confirmWord}
                  {copied ? <CheckIcon className="size-3.5 text-muted-foreground" /> : <CopyIcon className="size-3.5 text-muted-foreground" />}
                  <span className="sr-only">{copied ? " copied" : " — copy"}</span>
                </button>
                to confirm
              </p>
              <Input
                id={id}
                aria-label={`Type ${confirmWord} to confirm`}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={busy} disabled={!armed}>
              {busy ? "Working…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
