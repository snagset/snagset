import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "@/components/app/NotFound";

/**
 * Any address the dashboard has no page for. A splat under the signed-in
 * layout, not the root's not-found, so it gets the gate and the shell: signed
 * in, the sidebar stays the way out; signed out, sign-in first, then back here.
 */
export const Route = createFileRoute("/_app/$")({
  component: NotFound,
});
