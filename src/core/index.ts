// The plan model, with no dependency on VS Code: what the tests load and what the
// extension and the view share.
export * from './model';
export { diffChange, equal, alignLists, countLeaves, forcedPaths, maskAttrs, attrAt, parseEncodedJson } from './diff';
export { parsePlanJson, readPlanJson, isPlanJson, describeJson, actionOf, PlanJsonError } from './json';
export { parsePlanText, unquote, treeValue, actionsOf } from './text';
export { cleanLog, type Cleaned } from './ansi';
export { detectPlan, looksLikePlanJson, looksLikePlanText, looksLikeBinaryPlan, decodeText, DETECT_BYTES, DETECT_TEXT_BYTES, type PlanKind } from './detect';
// inspectBinaryPlan lives in ./tfplan: it needs node's zlib, which the view can't bundle.
export { toMarkdown, toSummary, codeSpan, mdText, htmlText, renderValue, changedLeaves, REASON_TEXT, type MarkdownOptions } from './markdown';
export { comparePlans, type Comparison, type CompareRow, type CompareStatus } from './compare';

import { parsePlanJson, PlanJsonError } from './json';
import { parsePlanText } from './text';
import { detectPlan, DETECT_TEXT_BYTES } from './detect';
import type { Plan } from './model';

export class NotAPlan extends Error {}

/** Reads a plan from text of either kind. */
export function parsePlan(text: string, kind?: 'json' | 'text'): Plan {
  // A long CI log may start its plan past the part detection looks at: look at all of it
  // before saying it isn't a plan.
  const k = kind ?? detectPlan(text) ?? (text.length > DETECT_TEXT_BYTES ? detectPlan(text, true) : undefined);
  if (k === 'json') return parsePlanJson(text);
  if (k === 'text') return parsePlanText(text);
  const t = text.trimStart();
  if (t.startsWith('{')) {
    // JSON that didn't look like a plan: say what it is.
    try {
      return parsePlanJson(text);
    } catch (e) {
      if (e instanceof PlanJsonError) throw new NotAPlan(e.message);
      throw e;
    }
  }
  throw new NotAPlan("This doesn't look like a plan: no `format_version` and `resource_changes` (plan JSON), and none of the lines a `terraform plan` writes.");
}
