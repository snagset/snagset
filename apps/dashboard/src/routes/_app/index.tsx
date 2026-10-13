import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/**
 * `/` — Sites is the home. The Preact dashboard's deep links were
 * `/?project=<uid>&t=<key>`; they are honoured here so a link pasted into a
 * chat last week still opens the thread it named.
 */
export const Route = createFileRoute("/_app/")({
  validateSearch: z.object({ project: z.string().optional(), t: z.string().optional() }),
  beforeLoad: ({ search }) => {
    if (search.project) {
      throw redirect({
        to: "/s/$site/comments",
        params: { site: search.project },
        search: { thread: search.t || undefined },
        replace: true,
      });
    }
    throw redirect({ to: "/sites", replace: true });
  },
});
