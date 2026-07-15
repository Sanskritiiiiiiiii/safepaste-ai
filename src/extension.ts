import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonWorker } from './pythonWorker';
import {
  PingPayload,
  PingResult,
  IndexPayload,
  IndexResult,
  CheckDuplicatesPayload,
  CheckDuplicatesResult,
  DuplicateMatch,
} from './protocol';
import { chunkRepository } from './index';
import { analyzeSafety, SafetyFinding } from './safetyAnalyzer';
import { analyzeArchitecture, ArchitectureFinding } from './architectureAnalyzer';
import { formatSummaryMessage, formatOutputSections, Finding } from './resultsFormatter';
import {
  createDiagnosticCollection,
  publishDiagnostics,
  clearDiagnostics,
  toSafetyDiagnostics,
  toArchitectureDiagnostics,
  toDuplicateDiagnostics,
} from './diagnostics';

let worker: PythonWorker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SafePaste AI');
  context.subscriptions.push(output);

  const scriptPath = path.join(context.extensionPath, 'python-worker', 'worker.py');


  // Config value rather than a hardcoded "python3" so this works on
  // Windows (often "python") without code changes — a one-line setting,
  // not a feature, so it doesn't fight the "avoid complexity" goal.
  const pythonExecutable = vscode.workspace
    .getConfiguration('safepaste')
    .get<string>('pythonPath', 'python3');

  worker = new PythonWorker(scriptPath, pythonExecutable, output);

  // Milestone 7: Problems panel integration. The collection itself and
  // all adapter/translation logic already live in diagnostics.ts
  // (built and verified in Step 1) — this is the only line needed to
  // instantiate it, same lifecycle pattern as the output channel above.
  const diagnosticCollection = createDiagnosticCollection();
  context.subscriptions.push(diagnosticCollection);

  // ---------------------------------------------------------------------
  // Milestone 6: status bar. One item for the extension's lifetime,
  // disposed via context.subscriptions like everything else here. All
  // text changes go through setStatus/setStatusTemporary below — no
  // other code in this file ever touches statusBarItem.text directly,
  // which is what "centralized" means in practice: one place to look to
  // see every possible status transition.
  // ---------------------------------------------------------------------

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  const READY_TEXT = '$(check) SafePaste Ready';
  const STATUS_RESET_DELAY_MS = 3000;

  // Incremented on every status change. A delayed reset-to-Ready only
  // applies if no newer status change has happened since it was
  // scheduled — otherwise a stale timer from an old operation could
  // clobber a newer operation's still-in-progress status.
  let statusGeneration = 0;

  function setStatus(text: string): void {
    statusGeneration++;
    statusBarItem.text = text;
  }

  function setStatusTemporary(text: string, resetDelayMs: number = STATUS_RESET_DELAY_MS): void {
    setStatus(text);
    const thisGeneration = statusGeneration;
    setTimeout(() => {
      if (statusGeneration === thisGeneration) {
        setStatus(READY_TEXT);
      }
    }, resetDelayMs);
  }

  setStatus(READY_TEXT); // initial state on activation

  const pingCommand = vscode.commands.registerCommand('safepaste.ping', async () => {
    output.show(true);
    output.appendLine('Sending ping to Python worker...');
    try {
      const result = await worker!.send<PingResult>('ping', {
        message: 'hello from extension',
      } satisfies PingPayload);
      output.appendLine(`Received: ${JSON.stringify(result)}`);
      vscode.window.showInformationMessage(
        `SafePaste worker replied: ${result.received}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Ping failed: ${message}`);
      vscode.window.showErrorMessage(`SafePaste worker error: ${message}`);
    }
  });

  context.subscriptions.push(pingCommand);

  // Milestone 1 debug command: chunk the open workspace and print results
  // so we can eyeball correctness before wiring chunks into indexing
  // (Milestone 2). Deliberately a separate command from `ping` — this has
  // nothing to do with the Python worker, it's pure TypeScript AST work.
  const chunkCommand = vscode.commands.registerCommand('safepaste.chunkRepo', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('SafePaste: open a folder or workspace first.');
      return;
    }

    output.show(true);
    output.appendLine(`Chunking repository at ${folder.uri.fsPath} ...\n`);

    const chunks = chunkRepository(folder.uri.fsPath);
    output.appendLine(`Found ${chunks.length} function-level chunk(s).\n`);

    for (const chunk of chunks) {
      output.appendLine(`— ${chunk.name}  (${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`);
      output.appendLine(chunk.code);
      output.appendLine('');
    }

    vscode.window.showInformationMessage(
      `SafePaste: found ${chunks.length} function-level chunk(s). See output panel.`
    );
  });

  context.subscriptions.push(chunkCommand);

  const indexCommand = vscode.commands.registerCommand('safepaste.indexRepo', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('SafePaste: open a folder or workspace first.');
      return;
    }

    const storageDir = getStorageDir(context);
    output.show(true);
    output.appendLine(`Chunking and indexing ${folder.uri.fsPath} ...`);
    setStatus('$(sync~spin) Indexing Repository...');

    // Milestone 6 Step 4: wraps the existing logic below in a progress
    // notification — nothing inside this callback is new except the
    // progress.report() calls themselves. cancellable: false is
    // deliberate: the Python worker call inside is a single awaited
    // request/response with no mid-flight abort in the protocol, so a
    // Cancel button here couldn't actually stop anything — offering one
    // anyway would be misleading. The status bar (set immediately above,
    // unchanged from Step 3) continues to reflect the same high-level
    // phase for as long as this notification is open, and keeps showing
    // afterward once the notification auto-dismisses.
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SafePaste: Indexing Repository',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Chunking repository...' });
        const chunks = chunkRepository(folder.uri.fsPath);
        output.appendLine(`Chunked ${chunks.length} function(s). Sending to Python worker for embedding...`);

        progress.report({ message: `Embedding ${chunks.length} chunk(s)...` });

        try {
          const result = await worker!.send<IndexResult>('index', {
            storageDir,
            chunks,
          } satisfies IndexPayload);
          output.appendLine(`Indexed ${result.chunksIndexed} chunk(s) into ${storageDir}`);
          if (result.failedChunks.length > 0) {
            output.appendLine(
              `Warning: ${result.failedChunks.length} chunk(s) could not be embedded (likely unusual characters in the source) and were skipped from duplicate matching:`
            );
            for (const id of result.failedChunks) {
              output.appendLine(`  - ${id}`);
            }
          }
          setStatusTemporary(`$(check) Indexed ${result.chunksIndexed} chunks`);
          vscode.window.showInformationMessage(
            result.failedChunks.length > 0
              ? `SafePaste: indexed ${result.chunksIndexed} chunk(s), ${result.failedChunks.length} skipped. See output panel.`
              : `SafePaste: indexed ${result.chunksIndexed} chunk(s).`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output.appendLine(`Indexing failed: ${message}`);
          setStatus(READY_TEXT);
          vscode.window.showErrorMessage(`SafePaste indexing error: ${message}`);
        }
      }
    );
  });

  context.subscriptions.push(indexCommand);

  const checkDuplicatesCommand = vscode.commands.registerCommand(
    'safepaste.checkDuplicates',
    async () => {
      const editor = vscode.window.activeTextEditor;
      const selectedText = editor?.document.getText(editor.selection);

      if (!selectedText) {
        vscode.window.showErrorMessage('SafePaste: select the code you want to check first.');
        return;
      }

      output.show(true);
      setStatus('$(sync~spin) Analyzing...');

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      // reportErrorsToUser: true — the user explicitly invoked this
      // command, so if something goes wrong (no workspace, worker
      // crashed, malformed safepaste.config.json, etc.) they should see
      // an error message about it.
      // checkDuplicates: true — unconditional, same as before Milestone 4:
      // a deliberate selection always gets the full check, unlike the
      // automatic paste path below which gates duplicate-checking on
      // length.
      try {
        await analyzePastedCode(
          selectedText,
          editor!.document.languageId,
          editor!.document.uri.fsPath,
          workspaceRoot,
          editor!.selection.start.line,
          { reportErrorsToUser: true, checkDuplicates: true }
        );
        setStatusTemporary('$(check) Analysis Complete');
      } catch {
        // analyzePastedCode's own sub-checks each have internal
        // try/catch and don't rethrow, so this shouldn't trigger in
        // practice — kept as a guarantee that the status bar always
        // returns to Ready rather than getting stuck on "Analyzing..."
        // if that assumption is ever wrong.
        setStatus(READY_TEXT);
      }
    }
  );

  context.subscriptions.push(checkDuplicatesCommand);

  // --- Milestone 3: automatic duplicate detection on paste ---
  //
  // Scoped to JS/TS/JSX/TSX only, matching the chunker's language scope
  // from Milestone 1 — no point checking pastes into files we never
  // indexed in the first place.
  const JS_TS_SELECTOR: vscode.DocumentSelector = [
    { language: 'javascript' },
    { language: 'javascriptreact' },
    { language: 'typescript' },
    { language: 'typescriptreact' },
  ];

  // Below this length, a paste is more likely to be a single identifier,
  // an import path, a bracket, etc. than a meaningful block of logic.
  // Skipping these avoids both wasted embedding calls and a popup firing
  // on every trivial paste, which would train users to ignore the tool.
  const MIN_PASTE_LENGTH_TO_CHECK = 20;

  const pasteProvider = {
    async provideDocumentPasteEdits(
      document: vscode.TextDocument,
      ranges: readonly vscode.Range[],
      dataTransfer: vscode.DataTransfer,
      _context: vscode.DocumentPasteEditContext,
      _token: vscode.CancellationToken
    ): Promise<undefined> {
      const item = dataTransfer.get('text/plain');
      const pastedText = await item?.asString();

      if (!pastedText) {
        return undefined;
      }

      // Fire-and-forget, deliberately not awaited: we only want to
      // *observe* this paste and check it in the background. Returning
      // `undefined` below tells VS Code we're not providing a paste
      // edit, so its normal default paste behavior inserts the text
      // exactly as it always would — this handler never alters what
      // gets pasted, only reacts to it afterward.
      //
      // checkDuplicates is gated by length, but safety analysis and the
      // architecture check are not: duplicate detection needs enough
      // text for a meaningful embedding, but a short snippet can still
      // be dangerous (`eval(x)` is 7 characters) or layer-violating, so
      // it would be wrong to skip those on the same threshold.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      void analyzePastedCode(
        pastedText,
        document.languageId,
        document.uri.fsPath,
        workspaceRoot,
        ranges[0]?.start.line ?? 0,
        {
          reportErrorsToUser: false,
          checkDuplicates: pastedText.trim().length >= MIN_PASTE_LENGTH_TO_CHECK,
        }
      );

      return undefined;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(JS_TS_SELECTOR, pasteProvider, {
      pasteMimeTypes: ['text/plain'],
      // We never actually return a DocumentPasteEdit (see
      // provideDocumentPasteEdits above — always returns undefined), so
      // this is empty. Declared explicitly rather than omitted because
      // some @types/vscode versions require this field.
      providedPasteEditKinds: [],
    })
  );

  /**
   * Fetches duplicate matches from the existing check_duplicates worker
   * command. Same call, same payload shape, same threshold behavior as
   * Milestone 2/3 — this is the original runDuplicateCheck() with its
   * body unchanged, except it now returns the result instead of showing
   * a notification itself. The caller (analyzePastedCode, below) decides
   * what to show once it also has the safety-analysis results.
   */
  async function runDuplicateCheck(
    code: string,
    reportErrorsToUser: boolean
  ): Promise<CheckDuplicatesResult | undefined> {
    let storageDir: string;
    try {
      storageDir = getStorageDir(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Duplicate check skipped: ${message}`);
      if (reportErrorsToUser) {
        vscode.window.showErrorMessage(`SafePaste: ${message}`);
      }
      return undefined;
    }

    output.appendLine('Checking for duplicates...');

    try {
      const result = await worker!.send<CheckDuplicatesResult>('check_duplicates', {
        storageDir,
        code,
        topK: 5,
      } satisfies CheckDuplicatesPayload);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Duplicate check failed: ${message}`);
      if (reportErrorsToUser) {
        vscode.window.showErrorMessage(`SafePaste duplicate check error: ${message}`);
      }
      return undefined;
    }
  }

  /**
   * Milestone 5 entry point (was Milestone 4's), used by both the manual
   * command and the automatic paste handler. Runs safety analysis and
   * architecture-compatibility analysis (both local, synchronous,
   * instant — no worker involved) and, if requested, duplicate detection
   * (async, via the unchanged existing worker flow), then shows exactly
   * one combined notification — or none at all if all three are clean,
   * extending Milestone 3's silence rule to safety and architecture
   * findings too.
   */
  async function analyzePastedCode(
    code: string,
    languageId: string,
    targetFilePath: string,
    workspaceRoot: string | undefined,
    pasteStartLine: number,
    options: { reportErrorsToUser: boolean; checkDuplicates: boolean }
  ): Promise<void> {
    const safetyFindings = analyzeSafety(code, languageId);

    // No workspace open -> no repo to have declared a
    // safepaste.config.json against, so there's nothing to check. Same
    // "silent when not applicable" precedent as everything else here —
    // this is not an error state.
    let architectureFindings: ArchitectureFinding[] = [];
    let architectureChecked = false;
    if (workspaceRoot) {
      try {
        architectureFindings = analyzeArchitecture(code, languageId, targetFilePath, workspaceRoot);
        architectureChecked = true;
      } catch (err) {
        // analyzeArchitecture only throws for a malformed
        // safepaste.config.json (missing config is a silent no-op, not
        // a throw — see architectureConfig.ts) — that's a real user
        // mistake worth logging, same treatment as any other failure
        // here: logged always, popped up only if the user explicitly
        // asked for this check.
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`Architecture check skipped: ${message}`);
        if (options.reportErrorsToUser) {
          vscode.window.showErrorMessage(`SafePaste: ${message}`);
        }
      }
    }

    const duplicateResult = options.checkDuplicates
      ? await runDuplicateCheck(code, options.reportErrorsToUser)
      : undefined;

    // Analysis is complete at this point — everything below is
    // presentation only, and each presentation channel is an
    // independent, parallel step, not nested inside another. Adding the
    // Problems panel here means adding a sibling call, not touching the
    // notification/output logic above or within showCombinedNotification.
    showCombinedNotification(
      safetyFindings,
      architectureFindings,
      architectureChecked,
      duplicateResult,
      options.checkDuplicates
    );

    publishDiagnosticsForAnalysis(
      targetFilePath,
      pasteStartLine,
      code.split('\n').length,
      workspaceRoot,
      safetyFindings,
      architectureFindings,
      architectureChecked,
      duplicateResult,
      options.checkDuplicates
    );
  }

  // ---------------------------------------------------------------------
  // Milestone 6: adapters converting each analyzer's own finding type
  // into resultsFormatter's generic Finding shape. This conversion is
  // deliberately kept here, not in resultsFormatter.ts — that module must
  // never know these analyzer-specific types exist.
  // ---------------------------------------------------------------------

  function toSafetyFindings(findings: SafetyFinding[]): Finding[] {
    return findings.map((f) => ({ category: 'Safety Analysis', message: f.message, line: f.line }));
  }

  function toArchitectureFindings(findings: ArchitectureFinding[]): Finding[] {
    return findings.map((f) => ({ category: 'Architecture Compatibility', message: f.message, line: f.line }));
  }

  function toDuplicateFindings(matches: DuplicateMatch[]): Finding[] {
    return matches.map((m) => ({
      category: 'Duplicate Detection',
      message: `Similar function already exists: ${m.name} (${m.filePath}:${m.startLine}-${m.endLine}, similarity ${m.similarity})`,
    }));
  }

  /**
   * Builds the combined Finding[] and category list, then delegates all
   * actual text formatting to resultsFormatter.ts. `architectureChecked`
   * and `duplicatesChecked` matter because an empty findings array can
   * mean either "checked, found nothing" or "never checked" — those are
   * different facts, and only the first should be reported as
   * "No issues found." A skipped check's category is simply omitted from
   * the report for that call, rather than falsely claiming it was clean.
   */
  function showCombinedNotification(
    safetyFindings: SafetyFinding[],
    architectureFindings: ArchitectureFinding[],
    architectureChecked: boolean,
    duplicateResult: CheckDuplicatesResult | undefined,
    duplicatesChecked: boolean
  ): void {
    const categories: string[] = [];
    if (duplicatesChecked) categories.push('Duplicate Detection');
    categories.push('Safety Analysis'); // always runs, unconditionally
    if (architectureChecked) categories.push('Architecture Compatibility');

    const allFindings: Finding[] = [
      ...(duplicatesChecked ? toDuplicateFindings(duplicateResult?.matches ?? []) : []),
      ...toSafetyFindings(safetyFindings),
      ...(architectureChecked ? toArchitectureFindings(architectureFindings) : []),
    ];

    // Output panel is pull-based (only visible if the user opens it), so
    // always logging the full report there — including "no issues
    // found" — is fine; it confirms the tool ran rather than looking
    // silent. This is more verbose than Milestone 5's output logging,
    // which only printed a category's lines when it had findings — a
    // deliberate, disclosed change per the Milestone 6 design.
    output.appendLine(formatOutputSections(categories, allFindings));

    // The notification popup keeps the exact same trigger condition as
    // Milestone 3 onward: silent unless allFindings is non-empty. Only
    // the wording changed (generic, via resultsFormatter), not when it
    // fires.
    const summary = formatSummaryMessage(allFindings);
    if (summary) {
      vscode.window.showWarningMessage(`⚠ ${summary}. See output panel for details.`);
    }
  }

  /**
   * Milestone 7: publishes the same already-computed findings to the
   * Problems panel. A sibling to showCombinedNotification above, not a
   * step inside it — this function does no analysis of its own, it only
   * converts data that already exists into vscode.Diagnostic[] via the
   * adapters already built and verified in diagnostics.ts, then
   * publishes or clears. Same "checked vs skipped" distinction as the
   * notification: a category that was never checked is omitted rather
   * than published as falsely clean.
   */
  function publishDiagnosticsForAnalysis(
    targetFilePath: string,
    pasteStartLine: number,
    pasteLineCount: number,
    workspaceRoot: string | undefined,
    safetyFindings: SafetyFinding[],
    architectureFindings: ArchitectureFinding[],
    architectureChecked: boolean,
    duplicateResult: CheckDuplicatesResult | undefined,
    duplicatesChecked: boolean
  ): void {
    const diagnostics = [
      ...toSafetyDiagnostics(safetyFindings, pasteStartLine),
      ...(architectureChecked ? toArchitectureDiagnostics(architectureFindings, pasteStartLine) : []),
      ...(duplicatesChecked && workspaceRoot
        ? toDuplicateDiagnostics(duplicateResult?.matches ?? [], pasteStartLine, pasteLineCount, workspaceRoot)
        : []),
    ];

    const uri = vscode.Uri.file(targetFilePath);
    if (diagnostics.length > 0) {
      publishDiagnostics(diagnosticCollection, uri, diagnostics);
    } else {
      clearDiagnostics(diagnosticCollection, uri);
    }
  }
}

/**
 * Where the vector index for the current workspace lives. Deliberately
 * outside the user's repo — VS Code's per-workspace storage directory,
 * not a folder inside their git repo — so we never touch their working
 * tree or ask them to .gitignore anything. Created on first use since
 * VS Code doesn't guarantee it already exists on disk.
 */
function getStorageDir(context: vscode.ExtensionContext): string {
  const storageUri = context.storageUri;
  if (!storageUri) {
    throw new Error('No workspace storage available — open a folder or workspace first.');
  }
  fs.mkdirSync(storageUri.fsPath, { recursive: true });
  return storageUri.fsPath;
}

export function deactivate(): void {
  worker?.dispose();
}
