import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

/**
 * The one place a screen's writes report themselves — saving, or saved a
 * moment ago. Deliberately SMALL and in a fixed spot: the alternative the
 * old dashboard ran was to disable the control you had just touched, which
 * put the feedback under your cursor and read as "that did not work". A
 * refusal is not shown here; it rolls the control back and says so in a
 * toast (rule 3).
 */
export function SaveState({ saving, savedAt }: { saving: boolean; savedAt: number | null }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);
  if (saving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground" aria-live="polite">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
        Saving
      </span>
    );
  }
  return (
    <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
      {show ? "Saved" : ""}
    </span>
  );
}
