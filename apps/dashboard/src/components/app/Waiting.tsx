import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Gate } from "./Gate";
import { Spinner } from "./Pending";

/**
 * The loading ladder. A loading screen that can stay up forever with nothing
 * to say — a Neon hiccup made "Loading your sites…" the whole dashboard for
 * as long as the TCP timeout — is worse than an honest one: at 4 s it says it
 * is still waiting, at 20 s it says why that probably is and offers the one
 * thing that helps.
 */
export function Waiting({ what = "Loading" }: { what?: string }) {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setWaited(1), 4_000);
    const t2 = setTimeout(() => setWaited(2), 20_000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  return (
    <Gate>
      <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground" aria-live="polite">
        <p className="m-0 flex items-center gap-2 text-foreground">
          <Spinner />
          {what}…
        </p>
        {waited >= 1 && <p className="m-0">Still waiting on the server.</p>}
        {waited >= 2 && (
          <>
            <p className="m-0 max-w-prose">
              It is probably waiting on its database. Reloading will not help until that clears, but it costs
              nothing to try.
            </p>
            <Button variant="outline" size="sm" onClick={() => location.reload()}>
              Try again
            </Button>
          </>
        )}
      </div>
    </Gate>
  );
}
