import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/panels/markdown.ts";

/**
 * The seven-node subset, asserted as a TREE rather than as HTML.
 *
 * That is the whole security argument made testable. The renderer produces
 * Preact nodes and never a string of HTML, so "did a `<script>` survive?" is
 * not a question about escaping — it is a question about whether a node of that
 * type exists, and a tree can answer it exactly. Text that looks like markup
 * shows up here as a STRING child, which is what reaches the DOM as a text node.
 *
 * No DOM, no renderer, no `preact-render-to-string`: `h()` returns a plain
 * object and the assertions read it directly.
 */

interface Node {
  type: unknown;
  props: { children?: unknown } & Record<string, unknown>;
}

/** `["p", ["strong", "bold"], " rest"]` — the tree, flattened for reading. */
function shape(node: unknown): unknown {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(shape).filter((n) => n !== null);
  const n = node as Node;
  // A single child is NOT an array — flattening one as if it were turns
  // ["pre", ["code", "x"]] into ["pre", "code", "x"], which reads as a <pre>
  // containing two strings and quietly passes the wrong assertion.
  const kids = n.props.children;
  const list = Array.isArray(kids) ? kids : kids === undefined ? [] : [kids];
  return [String(n.type), ...list.map(shape).filter((k) => k !== null)];
}

/** Every element type present anywhere in the tree. */
function types(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    if (typeof node[0] === "string" && !/^\s/.test(node[0])) into.add(node[0]);
    for (const k of node.slice(1)) types(k, into);
  }
  return into;
}

const md = (src: string): unknown => shape(renderMarkdown(src));

test("the seven nodes render, and each is the element it should be", () => {
  assert.deepEqual(md("**bold**"), ["div", ["p", ["strong", "bold"]]]);
  assert.deepEqual(md("*italic*"), ["div", ["p", ["em", "italic"]]]);
  assert.deepEqual(md("`code`"), ["div", ["p", ["code", "code"]]]);
  assert.deepEqual(md("```\nx = 1\n```"), ["div", ["pre", ["code", "x = 1"]]]);
  assert.deepEqual(md("- one\n- two"), ["div", ["ul", ["li", "one"], ["li", "two"]]]);
  assert.deepEqual(md("1. one\n2. two"), ["div", ["ol", ["li", "one"], ["li", "two"]]]);
  assert.deepEqual(md("[label](https://example.com)"), [
    "div",
    ["p", ["a", "label"]],
  ]);
});

test("AND NOTHING ELSE — the own words, as an assertion", () => {
  // Every construct a general markdown library would render and this one must
  // not. Each has to come out as text, because a reviewer who types `# 3` means
  // the number three and a reviewer who types `<b>` is quoting HTML at us.
  const rejected = [
    "# Heading",
    "> quote",
    "---",
    "![alt](https://example.com/x.png)",
    "| a | b |",
    "<b>bold</b>",
    "<img src=x onerror=alert(1)>",
    "~~strike~~",
    "term\n: definition",
    "[^1]: footnote",
  ];
  const allowed = new Set(["div", "p", "strong", "em", "code", "pre", "ul", "ol", "li", "a"]);
  for (const src of rejected) {
    for (const t of types(md(src))) {
      assert.ok(allowed.has(t), `"${src}" produced a <${t}>`);
    }
  }
});

test("MARKUP IN A COMMENT BODY IS TEXT, and stays text", () => {
  // The one that matters. There is no escaping step to get wrong: the string
  // arrives as a string child, which Preact commits as a text node.
  const attack = '<script>alert(1)</script><img src=x onerror="alert(2)">';
  const tree = md(attack);
  assert.deepEqual(tree, ["div", ["p", attack]]);
  assert.deepEqual([...types(tree)], ["div", "p"]);
});

test("a link's href is ALLOW-LISTED — the one dangerous value in the grammar", () => {
  const href = (src: string): string | undefined => {
    const found: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const node = n as Node;
      if (node.type === "a") found.push(String(node.props.href));
      const k = node.props?.children;
      if (Array.isArray(k)) k.forEach(walk);
      else walk(k);
    };
    walk(renderMarkdown(src));
    return found[0];
  };

  assert.equal(href("[x](https://example.com/a?b=1)"), "https://example.com/a?b=1");
  assert.equal(href("[x](http://example.com)"), "http://example.com");
  assert.equal(href("[x](mailto:a@example.com)"), "mailto:a@example.com");
  assert.equal(href("[x](/relative/path)"), "/relative/path");

  // A deny-list would have to know all of these; an allow-list knows none of
  // them and refuses them anyway, which is the point.
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "blob:https://example.com/x",
    "//evil.example/path",
  ]) {
    assert.equal(href(`[x](${bad})`), undefined, `${bad} produced a link`);
  }
});

test("a refused link renders its RAW SOURCE — the attempt stays visible", () => {
  // Rendering the label alone would leave an innocuous "click me" on screen and
  // hide the attempt from the studio reading the round. Showing the source is
  // both the honest thing to do with input we declined to interpret and the
  // thing that makes an attack legible to its recipient.
  assert.deepEqual(md("[click me](javascript:alert(1))"), [
    "div",
    ["p", "[click me](javascript:alert(1))"],
  ]);
  assert.deepEqual(md("[x](data:text/html,<script>)"), [
    "div",
    ["p", "[x](data:text/html,<script>)"],
  ]);
});

test("a legitimate URL with parentheses still links", () => {
  const tree = md("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))");
  assert.deepEqual(tree, ["div", ["p", ["a", "Foo"]]]);
});

test("an unmatched marker is just a character", () => {
  // `2 * 3 * 4` is arithmetic. A grammar that swallows stray punctuation makes
  // people fight the box, and a review comment is full of stray punctuation.
  assert.deepEqual(md("2 * 3"), ["div", ["p", "2 * 3"]]);
  // `snake_case` is ordinary writing in a tool aimed at people reading code.
  assert.deepEqual(md("a_b_c"), ["div", ["p", "a_b_c"]]);
  assert.deepEqual(md("call read_file_sync now"), ["div", ["p", "call read_file_sync now"]]);
  // …but a standalone pair still emphasises.
  assert.deepEqual(md("_yes_"), ["div", ["p", ["em", "yes"]]]);
  // Found by an XSS test, of all things: with a boundary class that excluded
  // letters and digits but not the UNDERSCORE, the single-underscore rule
  // opened on the second `_` of `window.__pwned` and closed on the first `_` of
  // the next one — italicising a pasted line of JavaScript and eating one
  // character from each end. A body rendered ALMOST verbatim is worse than one
  // rendered as markup, because nobody can see which character went.
  const dunder = "window.__pwned = 1; window.__pwned = 2;";
  assert.deepEqual(md(dunder), ["div", ["p", dunder]]);
  assert.deepEqual(md("__dunder__ and __another__"), [
    "div",
    ["p", ["strong", "dunder"], " and ", ["strong", "another"]],
  ]);
  assert.deepEqual(md("**unclosed"), ["div", ["p", "**unclosed"]]);
  assert.deepEqual(md("`unclosed"), ["div", ["p", "`unclosed"]]);
  assert.deepEqual(md("[label](unclosed"), ["div", ["p", "[label](unclosed"]]);
});

test("A SINGLE ASTERISK IS NOT HALF OF A DOUBLE ONE", () => {
  // `exec` finds the LEFTMOST match, not the longest, so ordering bold first in
  // the alternation does not help: on `*a **b** c*` the single-asterisk rule won
  // at index 0 and rendered `<em>a *</em>b<em>* c</em>` — a mangled sentence
  // from a comment somebody would plausibly write. Both ends of the rule now
  // refuse an asterisk that has another beside it.
  assert.deepEqual(md("*a **b** c*"), ["div", ["p", ["em", "a ", ["strong", "b"], " c"]]]);
  assert.deepEqual(md("**a** and *b*"), [
    "div",
    ["p", ["strong", "a"], " and ", ["em", "b"]],
  ]);
  assert.deepEqual(md("*just italic*"), ["div", ["p", ["em", "just italic"]]]);
  assert.deepEqual(md("**just bold**"), ["div", ["p", ["strong", "just bold"]]]);
});

test("backticks are a LEAF — markup inside them is not parsed", () => {
  assert.deepEqual(md("`**not bold**`"), ["div", ["p", ["code", "**not bold**"]]]);
  assert.deepEqual(md("```\n**not bold**\n```"), ["div", ["pre", ["code", "**not bold**"]]]);
});

test("an unclosed fence still terminates", () => {
  // Otherwise a stray ``` at the end of a comment eats the rest of the render
  // loop — or, worse, does not terminate it.
  assert.deepEqual(md("```\nstuck"), ["div", ["pre", ["code", "stuck"]]]);
});

test("a single newline is kept; a blank line separates", () => {
  assert.deepEqual(md("one\ntwo"), ["div", ["p", "one\ntwo"]]);
  assert.deepEqual(md("one\n\ntwo"), ["div", ["p", "one"], ["p", "two"]]);
});

test("an empty body renders an empty container, not undefined", () => {
  assert.deepEqual(md(""), ["div"]);
  assert.deepEqual(md("   "), ["div"]);
});

test("A DEEPLY NESTED BODY CANNOT OVERFLOW THE RENDERER", () => {
  // Found by adversarial review, in code written the same day. `"_".repeat(4000)`
  // an in-cap body .3's 10 000-char limit — produced a 1,002-deep
  // tree of <strong>s, because `\w` includes the underscore and so the bold
  // rule's closing `__(?!\w)` can only be satisfied at end-of-string on a run of
  // them. Preact overflowed the stack rendering it, which aborted the whole Dock
  // render: the panel went blank, and because the delete control sits in the
  // same card as the body, the comment that did it could not be removed through
  // the UI. One comment, from anyone holding the review link, bricking the panel
  // permanently for every reader of that thread.
  //
  // The typed tree bounds what can EXIST. This bounds how much.
  const depth = (n: unknown): number => {
    let d = 0;
    let cur = n as { props?: { children?: unknown } } | undefined;
    while (cur && typeof cur === "object" && cur.props) {
      d++;
      const k = cur.props.children;
      cur = (Array.isArray(k) ? k[0] : k) as typeof cur;
    }
    return d;
  };
  for (const n of [1_000, 4_000, 10_000]) {
    assert.ok(depth(renderMarkdown("_".repeat(n))) <= 8, `${n} underscores nested too deep`);
    assert.ok(depth(renderMarkdown("*".repeat(n))) <= 8, `${n} asterisks nested too deep`);
  }
  // Ordinary nesting still works — bold inside italic is two levels and the cap
  // is four, so nothing a person would actually write is affected.
  assert.deepEqual(md("*a **b** c*"), ["div", ["p", ["em", "a ", ["strong", "b"], " c"]]]);
});
