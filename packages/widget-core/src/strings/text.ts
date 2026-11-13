import { make } from "./format.ts";

/**
 * The FIFTH catalogue — what only the TEXT chunk renders: the selection
 * chip and its refusal twin. Deliberately NOT merged with
 * en.ts: importing the capture catalogue for two strings dragged the whole
 * shared catalogue into snag.text.js, which is the exact packaging mistake
 * the four-way split exists to prevent. en.ts's two rules apply unrestated:
 * no brand literal, no sentence assembled from fragments.
 */
export const textStrings = {
  "chip.comment": "Comment",
  // A selection inside a form field is the input's VALUE, and input values
  // are never captured as text — said where the reviewer is looking.
  "chip.notext": "Can't comment on typed text",
} as const;

export const format = make(textStrings);
