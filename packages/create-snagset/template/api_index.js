// The serverless entry — one line, because `@snagset/server` exports the
// Web-standard `fetch(Request) => Response` handler every platform accepts.
//
// Vercel, Netlify Functions, Cloudflare Workers and Deno Deploy all take this
// shape. Migrations run as a DEPLOY step, not on cold start (see README) —
// migrating on a request's critical path would put every instance behind one
// applying DDL, on somebody's first page load.
export { default } from "@snagset/server/serverless";
