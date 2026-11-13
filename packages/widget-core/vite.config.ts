import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import { placeholder } from "./scripts/build-id.mjs";

/**
 * Strip comments out of the CSS template literals — at BUILD time only.
 *
 * A comment inside a template literal is string DATA, not code, so no minifier
 * touches it and every byte ships. This codebase explains its CSS heavily and
 * that is deliberate; what was not deliberate is that 2.7 KB gzipped of those
 * explanations were being downloaded by every reviewer, 1.4 KB of it inside the
 * EAGER runtime chunk. Measured, not guessed: gzipping the built bundles with
 * and without them is the whole diagnosis.
 *
 * So the comments stay exactly where they are useful — beside the declaration
 * they explain — and stop being shipped. verify-dist asserts the artefacts come
 * out clean, so this cannot silently regress if the plugin is dropped.
 *
 * The guard is deliberately narrow: a literal only qualifies if it looks like a
 * real stylesheet — a `{…:…}` block, a semicolon, a newline AND a comment. A
 * template holding, say, a JSON fragment would match a `{"a":1}` test on its
 * own, which is why one condition is not enough.
 */
/**
 * Strip the CATALOGUES' prose too — same defect, different syntax.
 *
 * esbuild's minifier drops most comments and PRESERVES ONE KIND: a comment
 * leading an object-literal property. The four string catalogues are nothing
 * but heavily-annotated object literals, so every word of explanation beside
 * every string shipped. Measured on the artefacts: 6.4 KB gzipped across the
 * two EAGER chunks — 3.4 in the runtime and 3.1 in the panels — against an
 * envelope with 80 bytes of margin.
 *
 * Narrow on purpose: only `src/strings/*.ts`, and only whole-line `//`
 * comments. Those files contain an object literal and a `make()` call and
 * nothing else, so there is no template literal for a `//` line to be DATA
 * inside of. A general pass over every module would be a bigger blast radius
 * than the problem.
 *
 * verify-dist asserts the artefacts come out clean, so a file that grows a new
 * kind of surviving comment is a failed build rather than a silent regression.
 */
function stripCatalogueComments(): Plugin {
  return {
    name: "snagset:strip-catalogue-comments",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]strings[\\/][a-z]+\.ts$/.test(id)) return null;
      const out = code
        .split("\n")
        .filter((line) => !/^\s*\/\/(?!\s*@)/.test(line))
        .join("\n");
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * Strip EVERY whole-line `//` comment that would otherwise ship — the general
 * case the two narrow plugins above grew into.
 *
 * Vite's lib-mode ES output runs esbuild WITHOUT whitespace minification (so
 * `@__PURE__` annotations survive for consumers' bundlers), and without it
 * esbuild keeps comments attached to surviving syntax — class fields, object
 * properties, some statement positions. Measured on the artefacts: 92 shipped
 * comment lines in the eager runtime chunk alone, discovered while hunting a
 * 33-byte envelope overage.
 *
 * The catalogue plugin's blanket line-filter is only safe where no template
 * literal exists for a `//` line to be DATA inside of; this pass makes the
 * same edit safe everywhere by actually tracking lexical state — strings,
 * templates and `${}` nesting — and only deleting a line-initial comment seen
 * in code position. `//@` and `//#` lines (directives, source-map pragmas)
 * are kept, same carve-out as the catalogue plugin.
 *
 * verify-dist asserts the artefacts come out clean, so a comment shape this
 * scanner misses is a failed build rather than a silent regression.
 */
function stripLineComments(): Plugin {
  return {
    name: "snagset:strip-line-comments",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]src[\\/].*\.tsx?$/.test(id)) return null;
      const drop: [number, number][] = []; // [lineStart, afterNewline)
      // normal / ' / " / ` states; template depth tracks ${ … } nesting.
      let i = 0;
      const n = code.length;
      let mode: "code" | "'" | '"' | "`" = "code";
      const tmpl: number[] = []; // brace depth per open template
      // The last significant char, for the / regex-vs-division call. Getting
      // this wrong is not conservative: a regex containing a quote (resolve.ts
      // has /["\\]/) flips the string state and every judgement after it is
      // parity-inverted — which is how a `//` inside real string DATA could be
      // deleted. Prev-token is the textbook disambiguation and enough here.
      let prev = "";
      const regexBefore = (): boolean => {
        if (prev === "") return true;
        if ("(=,:[!&|?{};+-*%~^<>".includes(prev)) return true;
        // keyword endings: return/typeof/case/in/of/instanceof/new/delete/void/else/do/yield/await
        const tail = code.slice(Math.max(0, i - 16), i).trimEnd();
        return /(?:^|[^\w$])(?:return|typeof|case|instanceof|new|delete|void|else|do|yield|await|in|of)$/.test(tail);
      };
      const skipRegex = (): void => {
        i++; // opening /
        let cls = false;
        while (i < n) {
          const r = code[i]!;
          if (r === "\\") i += 2;
          else if (r === "[") (cls = true), i++;
          else if (r === "]") (cls = false), i++;
          else if (r === "/" && !cls) {
            i++;
            while (i < n && /[a-z]/i.test(code[i]!)) i++;
            return;
          } else if (r === "\n") return; // not a regex after all — bail
          else i++;
        }
      };
      while (i < n) {
        const c = code[i]!;
        if (mode === "code" && !/\s/.test(c) && c !== "/" ) prev = c;
        if (mode === "code") {
          if (c === "'" || c === '"' || c === "`") {
            mode = c as typeof mode;
            if (c === "`") tmpl.push(0);
            i++;
          } else if (c === "/" && code[i + 1] === "/") {
            const ls = code.lastIndexOf("\n", i - 1) + 1;
            const le = code.indexOf("\n", i);
            const end = le === -1 ? n : le + 1;
            if (!/^\/\/[@#]/.test(code.slice(i, i + 3))) {
              // Whole-line: drop the line. Trailing after code: drop to the
              // newline only — esbuild re-emits trailing comments on their own
              // output line, so these ship exactly like whole-line ones.
              if (/^\s*$/.test(code.slice(ls, i))) drop.push([ls, end]);
              else drop.push([i, le === -1 ? n : le]);
            }
            i = end;
          } else if (c === "/" && code[i + 1] === "*") {
            const close = code.indexOf("*/", i + 2);
            i = close === -1 ? n : close + 2;
          } else if (c === "/" && regexBefore()) {
            skipRegex();
            prev = "x"; // a regex literal ends like a value — next / divides
          } else if (c === "}" && tmpl.length > 0) {
            // could be the end of a ${ … } — only if we entered via one
            if (tmpl[tmpl.length - 1]! === 0) {
              mode = "`";
            } else {
              tmpl[tmpl.length - 1]!--;
            }
            i++;
          } else if (c === "{" && tmpl.length > 0) {
            tmpl[tmpl.length - 1]!++;
            i++;
          } else {
            i++;
          }
        } else if (mode === "`") {
          if (c === "\\") i += 2;
          else if (c === "`") {
            tmpl.pop();
            mode = "code";
            i++;
          } else if (c === "$" && code[i + 1] === "{") {
            mode = "code";
            i += 2;
          } else i++;
        } else {
          // ' or "
          if (c === "\\") i += 2;
          else if (c === mode) {
            mode = "code";
            i++;
          } else i++;
        }
      }
      if (!drop.length) return null;
      let out = "";
      let last = 0;
      for (const [s, e] of drop) {
        out += code.slice(last, s);
        last = e;
      }
      out += code.slice(last);
      return { code: out, map: null };
    },
  };
}

/**
 * Whitespace-minify the FINAL chunk — the other half of what lib mode skips.
 *
 * Vite's lib-mode ES output deliberately runs esbuild without
 * `minifyWhitespace` so `@__PURE__` annotations survive for consumers'
 * bundlers. Our artefacts are terminal — a browser fetches them off a CDN,
 * no downstream bundler exists — so the formatting is pure wire weight:
 * measured at ~2.5 KB gzipped across the two EAGER chunks alone, discovered
 * when the clustering left the envelope 10 bytes of margin. esbuild
 * re-emits pure annotations itself, so nothing the skip was protecting is
 * lost; done in renderChunk so Vite composes the sourcemap chain and the
 * screenshot chunk's LOCK-L5 map assertion keeps working.
 */
function minifyWhitespace(): Plugin {
  return {
    name: "snagset:minify-whitespace",
    // AFTER Vite's own esbuild pass. Without this the two fight and Vite wins:
    // its minifier re-PRINTS the chunk, and a printer with minifyWhitespace
    // off re-indents everything this plugin just removed. The symptom is
    // silent — identifiers are still mangled, so the output looks minified —
    // and it cost 7.2 kB of raw formatting in snag.runtime.js before the
    // envelope re-derivation went looking for the missing bytes.
    enforce: "post",
    async renderChunk(code, chunk) {
      const out = await transformWithEsbuild(code, chunk.fileName, {
        minify: true,
        target: "es2022",
        // renderChunk output is plain JS — without this, a .tsx chunk name
        // would make esbuild try to parse JSX again.
        loader: "js",
        treeShaking: false,
      });
      return { code: out.code, map: out.map ?? null };
    },
  };
}

/**
 * Collapse the INDENTATION out of a CSS template literal.
 *
 * esbuild's minifier does not touch template-literal contents — they are data,
 * not code — so every stylesheet in this package shipped with the newlines and
 * two-space indent it was authored with: 7.4 kB raw in `snag.runtime.js` alone,
 * and the eager envelope is the one budget measured in bytes.
 *
 * Whitespace in CSS is not always removable, which is why this is a function
 * with rules rather than a `.replace(/\s+/g, "")`:
 *
 *  - `.a\n  .b{…}` is a DESCENDANT combinator. Deleting that run changes the
 *    selector to `.a.b` and silently restyles the wrong element — the exact
 *    class of bug a size optimisation must never introduce.
 *  - `content:"a b"` and `${…}` interpolations are not CSS at all; the first is
 *    author-visible text, the second is JavaScript.
 *
 * So: protect the strings and the interpolations, then delete a whitespace run
 * only when the character on ONE side of it is a boundary that cannot be part
 * of an identifier (`{`, `}`, `;`, `,`, or the ends). Everything else collapses
 * to a single space, which preserves combinators while still paying for one
 * byte instead of three.
 */
function squeezeCss(lit: string): string {
  const held: string[] = [];
  // `${…}` first — an interpolation may itself contain a quote.
  let s = lit.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, (m) => `\u0000${held.push(m) - 1}\u0000`);
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => `\u0000${held.push(m) - 1}\u0000`);

  const BOUND = /[{};,]/;
  s = s.replace(/\s+/g, (run, at: number) => {
    const before = s[at - 1] ?? "";
    const after = s[at + run.length] ?? "";
    if (before === "" || after === "") return "";
    return BOUND.test(before) || BOUND.test(after) ? "" : " ";
  });

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]!);
}

function stripCssComments(): Plugin {
  return {
    name: "snagset:strip-css-comments",
    enforce: "pre",
    transform(code, id) {
      if (!/\.tsx?$/.test(id)) return null;
      let touched = false;
      const out = code.replace(/`(?:[^`\\]|\\.)*`/g, (lit) => {
        if (!lit.includes("/*") || !lit.includes(";") || !lit.includes("\n")) return lit;
        if (!/\{[^}]*:/.test(lit)) return lit;
        touched = true;
        return squeezeCss(
          lit
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{2,}/g, "\n"),
        );
      });
      return touched ? { code: out, map: null } : null;
    },
  };
}

/**
 * `src/build.ts`, as the artefacts see it: the release version and a
 * placeholder for the content hash, which `scripts/build-id.mjs` writes over
 * the placeholder after the last pass. A module swap rather than a
 * `define` — retired build-time defines — so the source holds an
 * ordinary export and nothing the build alone can see.
 */
function buildId(): Plugin {
  return {
    name: "snagset:build-id",
    enforce: "pre",
    transform(_code, id) {
      if (!/[\\/]src[\\/]build\.ts$/.test(id)) return null;
      return { code: `export const VERSION = ${JSON.stringify(placeholder())};`, map: null };
    },
  };
}

/**
 * One build pass PER ARTEFACT (Vite over esbuild/tsup for
 * chunk-filename control).
 *
 * Deliberately not one multi-entry pass. Rollup hoists code shared between
 * entries into an extra hashed chunk (`names-B8eFC2Cx.js` appeared the moment
 * the panels entry was added) — a file no registry knows about, whose name
 * changes every build, and which the stub cannot predict. Separate passes cost
 * a few hundred duplicated bytes and buy an artefact set that exactly matches
 * registry.json, which verify-dist now asserts so it cannot silently return.
 *
 *   --mode stub     → snag.js          IIFE, the tax every visitor pays
 *   --mode runtime  → snag.runtime.js  ES, vanilla
 *   --mode panels   → snag.panels.js   ES, Preact lives here and nowhere else
 */
const ENTRIES = {
  runtime: { entry: "src/runtime/index.ts", file: "snag.runtime.js" },
  panels: { entry: "src/panels/index.ts", file: "snag.panels.js" },
  capture: { entry: "src/capture/index.ts", file: "snag.capture.js" },
  "anchor-ext": { entry: "src/anchor/ext.ts", file: "snag.anchor-ext.js" },
  // The remaining three .8's five lazy artefacts,
  // real build outputs from day one so the loader contract and the
  // block-each-chunk degradation tests exist before the contents do.
  crumbs: { entry: "src/crumbs/index.ts", file: "snag.crumbs.js" },
  dock: { entry: "src/dock/index.ts", file: "snag.dock.js" },
  screenshot: { entry: "src/screenshot/index.ts", file: "snag.screenshot.js" },
  "anchor-fuzzy": { entry: "src/anchor/fuzzy.ts", file: "snag.anchor-fuzzy.js" },
  // Creation-side text picking — the tenth artefact (registry $comment has the why).
  text: { entry: "src/text/index.ts", file: "snag.text.js" },
} as const;


export default defineConfig(({ mode }) => {
  const stub = mode === "stub";
  const chunk = ENTRIES[mode as keyof typeof ENTRIES];

  return {
    plugins: [buildId(), stripCssComments(), stripCatalogueComments(), stripLineComments(), minifyWhitespace()],
    // JSX compiles straight to Preact — no React compatibility layer anywhere.
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    build: {
      // "esnext" here is NOT the artefacts' target — `minifyWhitespace()` above
      // emits es2022, and verify-dist asserts it. It is how Vite is told to
      // SKIP its own renderChunk transpile, which runs after every plugin's and
      // re-prints the chunk: with `minify: false` that printer restores all the
      // formatting our pass just removed, mangled identifiers and all, so the
      // output looked minified while carrying 7.2 kB of raw indentation.
      target: "esnext",
      emptyOutDir: false, // the passes share dist/
      // OFF, and `minifyWhitespace()` above is the whole minifier instead.
      // Not a downgrade — the same esbuild, one pass later. Vite's lib mode
      // runs esbuild with `minifyWhitespace` disabled to preserve `@__PURE__`
      // for a downstream bundler, and it runs LAST, so a renderChunk plugin
      // that removed the formatting had it printed straight back in. Our
      // artefacts are terminal (a browser fetches them off a CDN; there is no
      // downstream bundler), and esbuild re-emits pure annotations itself.
      minify: false,
      /**
       * Source maps on EVERY pass, for `tools/module-map.mjs`.
       *
       * The map is how a region's bytes are attributed after minification and
       * tree-shaking — summing source files would measure something nobody
       * downloads. Two passes were emitting none, so the capture chunk's
       * redaction predicates, which task 2's DoD names explicitly, could not be
       * measured at all.
       *
       * `"hidden"`, not `true`, and the difference is 72 bytes of the runtime
       * envelope. `true` appends a `//# sourceMappingURL=` comment to every
       * artefact — real bytes on every reviewer's wire, for a file only a
       * developer with devtools open ever fetches. `hidden` writes the map and
       * omits the comment, which is exactly the trade this build wants: the
       * tooling can read it, nobody downloads a pointer to it.
       *
       * Caught by the size gate the moment sourcemaps went on, at 40.07/40.
       */
      sourcemap: "hidden",
      lib: stub
        ? {
            entry: "src/loader.ts",
            formats: ["iife"],
            // Required by Vite for IIFE. The stub exports nothing, so Rollup
            // emits a bare `(function(){…})()` and this never becomes a global —
            // verify-dist asserts that, because an unregistered window.* on a
            // client's page would violate.
            name: "__snagset_stub__",
            fileName: () => "snag.js",
          }
        : {
            entry: chunk.entry,
            formats: ["es"],
            fileName: () => chunk.file,
          },
    },
  };
});
