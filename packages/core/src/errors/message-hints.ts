/**
 * Prose helpers for the actionable half of an error `detail`: the "did you
 * mean" suggestion and the bounded list of names the client may actually
 * use.
 *
 * Internal by design — not barrel-exported, and it appears in no public
 * signature. `detail` text is not typed API (ADR-0009 fixes the document
 * *shape*, and localization goes through `messageKey` + `messageParams`),
 * so these strings stay free to improve.
 *
 * **Disclosure rule (normative).** Every caller passes candidates drawn
 * only from the *permitted* set — includable relations, allowlisted
 * filterable/sortable/selectable fields — never the full relation or field
 * registry. That keeps what a rejection enumerates exactly equal to what
 * the client is already allowed to ask for.
 *
 * The rule's second half is about what a rejection must *not* confirm: a
 * message may never differ according to whether the rejected name exists.
 * Relation inclusion is opt-in and defaults to empty, so a message that
 * said "exists but is not includable" for one name and "does not exist" for
 * another would be an existence oracle for the very edges the config closed
 * on purpose. Advice about names outside the permitted set is therefore
 * phrased as a conditional ("if X has a 'y' relation"), which is equally
 * actionable for the developer and answers nothing for a prober.
 */

import type { QueryIssueDto } from "./problem-details.js";

/** Longest candidate list rendered in full before it is truncated. */
const DEFAULT_LIST_CAP = 10;

/**
 * The closest candidate to `input`, or `undefined` when nothing is close
 * enough to be worth guessing at.
 *
 * The threshold tightens for short names: at two edits, a three-letter
 * input is within reach of most three-letter candidates, and a confidently
 * wrong suggestion costs more than none at all.
 */
export function suggestName(input: string, candidates: readonly string[]): string | undefined {
  const threshold = input.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = threshold + 1;
  for (const candidate of candidates) {
    if (candidate === input) {
      continue;
    }
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase(), threshold);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= threshold ? best : undefined;
}

/**
 * Candidates as a sorted, comma-separated list — truncated with a total so
 * a 200-field entity does not turn one rejection into a wall of text.
 * `"none"` when there is nothing to offer, which is itself the answer on an
 * entity whose `relations.edges` is still empty.
 */
export function nameList(candidates: readonly string[], cap: number = DEFAULT_LIST_CAP): string {
  if (candidates.length === 0) {
    return "none";
  }
  const sorted = [...candidates].sort();
  if (sorted.length <= cap) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, cap).join(", ")}, … (${sorted.length} total)`;
}

/** Which allowlist a rejected field belongs to, keyed by how it was used. */
const ALLOWLIST_KEYS = Object.freeze({
  filtering: "filterable",
  sorting: "sortable",
  selection: "selectable",
  searching: "searchable",
} as const);

/** How each usage reads as an adjective in front of "fields". */
const ALLOWLIST_ADJECTIVES = Object.freeze({
  filtering: "Filterable",
  sorting: "Sortable",
  selection: "Selectable",
  searching: "Searchable",
} as const);

export type AllowlistUsage = keyof typeof ALLOWLIST_KEYS;

/**
 * The clause appended to an allowlist rejection, naming the near miss, the
 * permitted set, and the config key that would permit the field. Callers
 * own the leading sentence, which stays byte-identical to what it always
 * was — this is purely additive text.
 *
 * The config-key advice is phrased as a conditional on purpose. An
 * allowlist accepts whatever array the config declares — `resolveFieldSelector`
 * never checks it against `EntityMetadata` — so telling a developer to
 * allowlist a *typo* would trade this clear 400 for a 500 out of the driver
 * on the next query. "If it is a column" is the honest form, and it says
 * nothing about whether the column exists.
 */
export function allowlistHint(
  field: string,
  usage: AllowlistUsage,
  entityName: string,
  allowed: readonly string[],
): string {
  const suggestion = suggestName(field, allowed);
  return (
    (suggestion === undefined ? "" : ` Did you mean '${suggestion}'?`) +
    ` ${ALLOWLIST_ADJECTIVES[usage]} fields on ${entityName}: ${nameList(allowed)}.` +
    ` If ${entityName} has a '${field}' column, add it to allowed.${ALLOWLIST_KEYS[usage]}` +
    ` on the ${entityName} config to permit it.`
  );
}

/**
 * How many rejections in one request still carry the actionable clause.
 *
 * The hint is not free: `suggestName` walks the whole allowlist per rejected
 * name, and the prose adds a few hundred bytes to each issue. A request
 * naming five thousand fields (`?select=a1,…,a5000` is a legal query string)
 * would otherwise turn one 400 into a megabyte of text and an O(names ×
 * allowlist) edit-distance sweep. Past a handful of problems the caller is
 * not fixing a typo anyway, so the leading sentence carries on alone.
 *
 * The counter is the issue array itself, which may already hold unrelated
 * problems — deliberately conservative: it errs toward dropping the hint.
 */
const MAX_HINTED_ISSUES = 5;

/**
 * Push one allowlist rejection. The single construction site for this
 * message: the wire path (`DefaultFilterParser`) and the programmatic one
 * (`QueryNormalizer`) both land here, so the two cannot word the same
 * rejection differently.
 */
export function pushAllowlistIssue(
  field: string,
  usage: AllowlistUsage,
  entityName: string,
  allowed: readonly string[],
  issues: QueryIssueDto[],
): void {
  issues.push({
    field,
    code: "KAVO_QUERY_INVALID_FIELD",
    detail:
      `Field '${field}' cannot be used for ${usage}.` +
      (issues.length < MAX_HINTED_ISSUES ? allowlistHint(field, usage, entityName, allowed) : ""),
  });
}

/**
 * Optimal string alignment distance — Levenshtein plus adjacent
 * transposition, because transposing two characters is the typo people
 * actually make (`emial`, `nmae`) and plain Levenshtein charges it two
 * edits, putting it out of reach of a short name's budget.
 *
 * Returns `ceiling + 1` for anything provably past the budget: the distance
 * is never below the length difference, which settles most candidates
 * without building the matrix at all.
 */
function editDistance(a: string, b: string, ceiling: number): number {
  if (Math.abs(a.length - b.length) > ceiling) {
    return ceiling + 1;
  }
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let value = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2]! + 1);
      }
      current.push(value);
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length]!;
}
