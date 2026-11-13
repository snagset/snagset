/**
 * The shadow boundary, on both sides of it — and (v0).
 *
 * Two specs meet here and they want opposite things, which is why this is one
 * file rather than a constant copied into two:
 *
 *   · the design wants the hit test to go DOWN into the host page's open shadow
 *     roots, so the reviewer's crosshair lands on the button they can see
 *     rather than on the component that contains it.
 *   · the design wants anchor creation to come back UP to the host element,
 *     because a CSS selector cannot cross a shadow boundary and a record whose
 *     selector addresses nothing is a pin that orphans on the next load.
 *
 * Both are true at once, and the pair is what makes a web component pinnable:
 * you point at the button, the highlight outlines the button, the label quotes
 * the button, and the anchor addresses the host that can actually be found
 * again. The one thing that would be dishonest — claiming to have anchored to
 * the button — is the thing neither spec asks for at v0.
 *
 * Also carries `hostPath?: string[]` for addressing INSIDE an open root,
 * so a future version can anchor to the button itself. That is v0.1 (the
 * table) and deliberately not attempted here.
 */

/**
 * The cap, and the design says in as many words: *"10, same constant as the
 * hit test"*. Exported so that remains true by construction.
 */
export const MAX_SHADOW_DEPTH = 10;

/**
 * The element an ANCHOR should be built against — the v0 rule.
 *
 * *"walk `getRootNode().host` upward until the node's root is `document`, anchor
 * to the resulting host element, and push reason `'shadow-boundary'`."*
 *
 * Closed roots need no separate branch: `elementFromPoint` retargets to the
 * host, so a node from inside one never reaches this function in the first
 * place, and if one somehow did it would take the identical path.
 *
 * Returns the element unchanged when it is already in the document tree, which
 * is every ordinary pin — so this costs one `getRootNode()` on the creation
 * path and nothing at all on the resolution path.
 */
export function anchorTargetOf(el: Element): Element {
  let node: Element = el;
  let depth = 0;
  while (depth++ < MAX_SHADOW_DEPTH) {
    const root = node.getRootNode();
    // A detached subtree's root is neither a Document nor a ShadowRoot; stop
    // rather than loop, and let the caller's own resolution report it.
    if (!(root instanceof ShadowRoot)) break;
    node = root.host;
  }
  return node;
}

/** Was this element reached by crossing a shadow boundary? The composer uses it
 *  to say so, and it is the one fact a reviewer needs to understand why the pin
 *  sits on the component rather than on the control inside it. */
export function isInsideShadow(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot;
}

/**
 * The hosts crossed on the way out, OUTERMOST FIRST — the `hostPath`.
 *
 * The walk is the same one `anchorTargetOf` performs; this returns the elements
 * it passed rather than the one it stopped at, so a caller that can generate
 * selectors (the capture chunk) can turn them into the `string[]`.
 *
 * Empty for every ordinary element, which is the overwhelming majority — so the
 * cost on the creation path is one `getRootNode()` and nothing else.
 */
export function shadowHosts(el: Element): Element[] {
  const chain: Element[] = [];
  let node: Element = el;
  let depth = 0;
  while (depth++ < MAX_SHADOW_DEPTH) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    node = root.host;
    chain.unshift(node); // outermost first
  }
  return chain;
}
