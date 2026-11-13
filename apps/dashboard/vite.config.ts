import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";

/**
 * Built INTO the server's static assets, not deployed separately
 * one npm package, one process, one thing to deploy. The output
 * lands where `apps/server` serves it from, so `npx snagset` has a dashboard
 * with no second build step and no second host. The path is the ONE coupling
 * between this app and the server — the decision changed the framework and not the
 * path, which is why the harness and the package build did not notice.
 *
 * The dev server proxies the API to a locally running `snagset serve`, so this
 * app is developed against the real server rather than a mock — which is how
 * the CORS and cookie behaviour gets exercised during development instead of
 * after it.
 */
export default defineConfig({
  root: ".",
  plugins: [
    // Before react(): the router plugin generates `src/routeTree.gen.ts` from
    // `src/routes/` and must see the files before they are transformed.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "../server/static/dashboard",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5174,
    // Where the API lives while the dashboard runs under Vite. The server's
    // default port is the default here; SNAGSET_DEV_API points it elsewhere
    // for the case that actually happens — an instance kept off 8080 because
    // a QA server owns that port — without editing this file.
    //
    //   SNAGSET_DEV_API=http://127.0.0.1:8099 pnpm --filter @snagset/dashboard dev
    //
    // The two prefixes are exactly the two the server's session middleware is
    // mounted on; nothing else the dashboard fetches needs the server.
    proxy: {
      "/api": { target: process.env["SNAGSET_DEV_API"] ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/auth": { target: process.env["SNAGSET_DEV_API"] ?? "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
});
