import { useEffect } from "react";
import { init, type InitOptions } from "./index.ts";

/**
 * `snagset/react`, and the twenty-line wrapper predicted.
 *
 * ```tsx
 * import { Snagset } from "snagset/react";
 *
 * <Snagset host="https://review.example.com" site="prj_…" />
 * ```
 *
 * It renders NOTHING. There is no element to place, no wrapper div, no portal
 * the widget owns its own root in the DOM (the shadow host) and this
 * component's whole job is to run `init()` while it is on screen. Returning
 * `null` is the honest expression of that, and it means the component can sit
 * anywhere in a tree without affecting layout.
 *
 * `react` is an OPTIONAL peer dependency, so installing `snagset` in a Vue or
 * vanilla project pulls in no React and warns about nothing.
 *
 * `.ts`, NOT `.tsx`, because there is no JSX in it — a component that renders
 * nothing has nothing to render. The extension was `.tsx` out of habit, and it
 * cost something real: Node's type stripping handles `.ts` and refuses `.tsx`
 * (JSX needs a transform, not a strip), so the test that imports every subpath
 * to check its default export could not load this one.
 */

export type SnagsetProps = InitOptions;

export function Snagset(props: SnagsetProps): null {
  // Every value is in the dependency list via JSON, not the object identity:
  // a caller writing `<Snagset host={…} site={…} />` creates a new props object
  // every render, so depending on the object would tear down and re-mount the
  // widget on every parent render. This is the one place in twenty lines where
  // the obvious version is wrong.
  const key = JSON.stringify(props);
  useEffect(() => {
    // `init` returns its own teardown and is idempotent — which is what makes
    // this safe under React 18 strict mode, where effects run twice in
    // development and a naive implementation boots two widgets.
    return init(JSON.parse(key) as InitOptions);
  }, [key]);
  return null;
}

export default Snagset;
