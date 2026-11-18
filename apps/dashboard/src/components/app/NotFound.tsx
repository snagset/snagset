import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/parts";

/**
 * An address the dashboard has no page for — a mistyped URL, an old
 * bookmark, a link from before a page moved. Inside the shell when signed in,
 * so the sidebar is still the way out; the router's bare "Not Found" gave none.
 */
export function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-7">
      <EmptyState
        icon={<CompassIcon className="size-5" />}
        title="There is no page here"
        action={
          <Button variant="outline" size="sm" render={<Link to="/sites" />}>
            Go to Sites
          </Button>
        }
      >
        <p className="m-0">
          The address may be mistyped, or the page has moved. <code className="break-all">{window.location.pathname}</code>
        </p>
      </EmptyState>
    </div>
  );
}
