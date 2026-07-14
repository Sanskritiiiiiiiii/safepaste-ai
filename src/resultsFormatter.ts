/**
 * Pure presentation layer.
 *
 * Deliberately knows nothing about *where* a finding came from — there is
 * no concept of "safety", "architecture", or "duplicate detection"
 * hardcoded anywhere in this file. A Finding is just
 * { category, message, line? }: category is an opaque label the caller
 * supplies, never interpreted here, only grouped and displayed. That's
 * what makes this reusable for the Output panel, a notification, a log
 * line, a unit test, or a future Markdown report — none of those
 * consumers need to agree on what "categories" exist, and this module
 * never needs updating when a new finding source is added elsewhere in
 * the extension.
 *
 * No vscode import, no fs, no emojis/colors/UI chrome, no phrase like
 * "See output panel" (that references a specific UI surface — belongs
 * in extension.ts, not here). This file only ever returns plain text.
 */

export interface Finding {
  /** Caller-supplied label, e.g. "Safety Analysis". Grouped and printed verbatim, never interpreted. */
  category: string;
  /** Fully-formed, human-readable text. This module never builds finding text itself, only arranges it. */
  message: string;
  /** Optional location, meaning defined entirely by the caller. */
  line?: number;
}

/**
 * Builds a single summary line covering every finding, or `undefined` if
 * there are none — callers use `undefined` to decide whether to show
 * anything at all.
 */
export function formatSummaryMessage(findings: Finding[]): string | undefined {
  if (findings.length === 0) {
    return undefined;
  }

  const grouped = groupByCategory(findings);
  const clauses = Array.from(grouped.entries()).map(([category, categoryFindings]) =>
    summarizeCategory(category, categoryFindings)
  );

  return clauses.join(' | ');
}

/**
 * Builds a full multi-line report with one section per entry in
 * `categories`, in the order given — including categories with zero
 * findings, rendered as "No issues found." `categories` exists so this
 * function can render a complete, stable report shape without needing
 * to know in advance what categories are meaningful; that decision
 * stays entirely with the caller.
 */
export function formatOutputSections(categories: string[], findings: Finding[]): string {
  const grouped = groupByCategory(findings);
  return categories.map((category) => formatSection(category, grouped.get(category) ?? [])).join('\n\n');
}

// ---------------------------------------------------------------------
// Internal helpers. Not exported — the public API is deliberately just
// the two functions above.
// ---------------------------------------------------------------------

function groupByCategory(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.category);
    if (existing) {
      existing.push(finding);
    } else {
      grouped.set(finding.category, [finding]);
    }
  }
  return grouped;
}

/**
 * Summarizes one category's findings into a single clause. Purely
 * mechanical: shows the first finding's message, and if there are more,
 * appends "(+N more in <category>)" using the caller's own category
 * label verbatim — never inventing plural nouns or category-specific
 * wording, since that would require knowing what the category means.
 */
function summarizeCategory(category: string, findings: Finding[]): string {
  const first = stripTrailingPeriod(findings[0].message);
  if (findings.length === 1) {
    return first;
  }
  return `${first} (+${findings.length - 1} more in ${category})`;
}

function formatSection(category: string, findings: Finding[]): string {
  const lines = [`=== ${category} ===`];
  if (findings.length === 0) {
    lines.push('No issues found.');
  } else {
    for (const finding of findings) {
      const location = finding.line !== undefined ? `line ${finding.line}: ` : '';
      lines.push(`  - ${location}${finding.message}`);
    }
  }
  return lines.join('\n');
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.+$/, '');
}
