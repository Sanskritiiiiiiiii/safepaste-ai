import * as vscode from 'vscode';
import type { SafetyFinding } from './safetyAnalyzer';
import type { ArchitectureFinding } from './architectureAnalyzer';
import type { DuplicateMatch } from './protocol';

/**
 * Milestone 7, Step 1: converts each analyzer's own finding type directly
 * into vscode.Diagnostic[] — deliberately independent of
 * resultsFormatter.ts and its generic Finding type. That module stays
 * presentation-only and untouched; this one exists for a different
 * consumer (the editor's diagnostic/Code Action machinery) with a
 * different requirement (stable rule identity via `.code`), which is
 * exactly why it doesn't share the same pipeline. See the Milestone 7
 * design discussion for why this was chosen over extending Finding.
 *
 * Analyzer outputs and their public types are read here, never modified.
 */

const DIAGNOSTIC_COLLECTION_NAME = 'safepaste';

/** Fixed diagnostic code for duplicate findings — DuplicateMatch has no ruleId of its own. */
export const DUPLICATE_DIAGNOSTIC_CODE = 'duplicate-detection';

// ---------------------------------------------------------------------
// DiagnosticCollection lifecycle helpers.
// ---------------------------------------------------------------------

/**
 * Creates the one DiagnosticCollection this extension uses. Ownership
 * and disposal (via context.subscriptions) stay with extension.ts, same
 * as the output channel and status bar item — this function only
 * centralizes the collection's name so it's declared in exactly one
 * place.
 */
export function createDiagnosticCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
}

/** Replaces all diagnostics for `uri` with `diagnostics` in one atomic call. */
export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
  diagnostics: vscode.Diagnostic[]
): void {
  collection.set(uri, diagnostics);
}

/** Clears all diagnostics for `uri` — e.g. if a check finds nothing, any stale diagnostics from a previous paste should not linger. */
export function clearDiagnostics(collection: vscode.DiagnosticCollection, uri: vscode.Uri): void {
  collection.delete(uri);
}

// ---------------------------------------------------------------------
// Snippet-to-document line translation.
// ---------------------------------------------------------------------

/**
 * Analyzer findings report 1-indexed line numbers relative to the pasted
 * snippet (line 1 = the snippet's first line) — appropriate for
 * notifications/output text, but not sufficient on its own to position a
 * squiggly underline in the real document. This translates a
 * snippet-relative line into a document-relative, 0-indexed line number
 * (vscode.Position's convention), given the 0-indexed document line
 * where the paste/selection begins.
 *
 * Pure function, no vscode dependency — testable standalone.
 */
export function snippetLineToDocumentLine(snippetLine: number, pasteStartLine: number): number {
  return pasteStartLine + (snippetLine - 1);
}

/** A whole-line range at the given 0-indexed document line. End character is intentionally large — VS Code clamps it to the line's actual length when rendering, which avoids needing a live TextDocument here just to look up line length. */
function wholeLineRange(documentLine: number): vscode.Range {
  return new vscode.Range(documentLine, 0, documentLine, Number.MAX_SAFE_INTEGER);
}

/** A range spanning every line of the pasted block, for findings (like duplicates) that describe the paste as a whole rather than one specific line within it. */
function wholePasteRange(pasteStartLine: number, pasteLineCount: number): vscode.Range {
  const lastLine = pasteStartLine + Math.max(pasteLineCount - 1, 0);
  return new vscode.Range(pasteStartLine, 0, lastLine, Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------
// Adapters. Each takes one analyzer's own typed findings and returns
// vscode.Diagnostic[] — no `any`, no shared type with resultsFormatter.ts.
// ---------------------------------------------------------------------

export function toSafetyDiagnostics(findings: SafetyFinding[], pasteStartLine: number): vscode.Diagnostic[] {
  return findings.map((finding) => {
    const documentLine = snippetLineToDocumentLine(finding.line, pasteStartLine);
    const diagnostic = new vscode.Diagnostic(
      wholeLineRange(documentLine),
      finding.message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'SafePaste';
    diagnostic.code = finding.ruleId;
    return diagnostic;
  });
}

export function toArchitectureDiagnostics(
  findings: ArchitectureFinding[],
  pasteStartLine: number
): vscode.Diagnostic[] {
  return findings.map((finding) => {
    const documentLine = snippetLineToDocumentLine(finding.line, pasteStartLine);
    const diagnostic = new vscode.Diagnostic(
      wholeLineRange(documentLine),
      finding.message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'SafePaste';
    diagnostic.code = finding.ruleId;
    return diagnostic;
  });
}

/**
 * Duplicate matches describe the pasted block as a whole, not a specific
 * line within it (DuplicateMatch has no `line` field), so the diagnostic
 * spans the entire pasted range. `workspaceRoot` is needed to resolve
 * each match's repo-relative `filePath` into an absolute Uri for
 * relatedInformation — the mechanism Step 2's "Open existing
 * implementation" Code Action will read to know what to open.
 *
 * Severity is Information rather than Warning here, deliberately: a
 * duplicate isn't inherently wrong the way a security issue is — it's a
 * suggestion, not a defect.
 */
export function toDuplicateDiagnostics(
  matches: DuplicateMatch[],
  pasteStartLine: number,
  pasteLineCount: number,
  workspaceRoot: string
): vscode.Diagnostic[] {
  const range = wholePasteRange(pasteStartLine, pasteLineCount);

  return matches.map((match) => {
    const diagnostic = new vscode.Diagnostic(
      range,
      `Similar function already exists: ${match.name} (${match.filePath}:${match.startLine})`,
      vscode.DiagnosticSeverity.Information
    );
    diagnostic.source = 'SafePaste';
    diagnostic.code = DUPLICATE_DIAGNOSTIC_CODE;

    const targetUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), match.filePath);
    const targetLocation = new vscode.Location(
      targetUri,
      new vscode.Position(Math.max(match.startLine - 1, 0), 0)
    );
    diagnostic.relatedInformation = [
      new vscode.DiagnosticRelatedInformation(targetLocation, `Existing implementation: ${match.name}`),
    ];

    return diagnostic;
  });
}
