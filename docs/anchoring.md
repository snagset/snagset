# How anchoring works (and when pins orphan)

A comment is left on an *element*, not on a coordinate. That is the difference
between a review tool that survives your next deploy and one that turns into a
page of dots in the wrong places.

This page is how that works, what it costs, and — the part worth reading — what
you can do in your own markup to make it work better.

## What is recorded when somebody clicks

Several ways of naming the element, at once, strongest first:

| Recorded | Strategy | Confidence |
|---|---|---|
| `data-testid` | `testid` | 1.00 |
| `id` | `domid` | 1.00 |
| A CSS path | `css` | 0.90 |
| Its exact text | `text-exact` | 0.80 |
| Its text, fuzzily | `text-fuzzy` | 0.78 |
| Accessible name and role | `aria` | 0.75 |
| Position in the layout | `path-rect` | 0.35 |

Plus a proportional offset inside the element, so the pin lands where the person
pointed rather than in a corner.

## What happens on the next visit

Each strategy is tried and scored. The best score decides the pin's state:

| Score | State | What the reviewer sees |
|---|---|---|
| ≥ 0.75 | **anchored** | The pin, on the element, as left |
| ≥ 0.35 | **approximate** | The pin, marked as approximate |
| below | **orphaned** | The comment, in the list, with what it was left on |

Geometry is a **tie-break only**, capped at 0.05, and never a strategy on its
own. Two candidates that match equally well by name are separated by which is
closer to where the pin was; a candidate that matches by *nothing but* position
cannot reach `anchored` on its own, because a page that changed its layout is
exactly when position lies.

`text-fuzzy` is capped below the `anchored` threshold on purpose. A near-match
on text is a good guess and not a fact, and the honest ceiling is "approximate".

## Orphans are not lost

An orphaned pin keeps its thread, its screenshot, its author and its
description of what it was attached to — *"the Place order button"*. It moves to
the list rather than the page.

That is the correct outcome. A pin that re-anchors confidently to the wrong
element is worse than one that admits it cannot find its target: your client
reads a comment about the wrong thing and you fix the wrong thing.

You can filter for them in the dashboard, and an agent can ask for them by name
through MCP — *"fix the orphaned pins"* is a real task.

## Making it work better, in one line

**Add `data-testid`.** That is the whole recommendation.

```html
<button data-testid="checkout-submit">Place order</button>
```

It scores 1.00, it survives a restyle, a re-order, a text change and a
translation, and it is the same attribute your tests already want. An `id`
works identically. Nothing else you can do comes close.

The strategies below it are there for the markup you do not control — a CMS
block, a third-party embed, somebody else's component library.

## What breaks anchoring

- **Text that changes** — a counter, a date, a price. `text-exact` misses and
  the fuzzy pass caps at approximate.
- **Generated class names.** `css` paths through `.a1b2c3` from a CSS-in-JS
  build are re-generated per deploy.
- **Deep nesting with no stable hook.** The path is the only thing left, and
  paths are brittle by nature.
- **Genuinely deleting the element.** Nothing can fix this and nothing should
  pretend to — the comment orphans, which is the right answer.

## Shadow DOM and iframes

Elements inside an **open** shadow root anchor normally — the path crosses the
boundary. A **closed** shadow root is invisible to any script on the page,
including this one.

Same-origin iframes work. Cross-origin iframes cannot be reached by anything
running on the parent page; that is the browser's rule and not a limitation we
can lift.

## Rounds, and why old pins do not pile up

A round is a period of time, not a folder. Starting a new
one gives the page a clean surface — nothing is deleted, and the previous
round's comments are one click away. It is the answer to "the client has left
forty comments and I have fixed thirty of them", rather than asking anyone to
tidy up.
