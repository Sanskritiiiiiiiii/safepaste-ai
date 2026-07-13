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
} from './protocol';
import { chunkRepository } from './index';
import { analyzeSafety, SafetyFinding } from './safetyAnalyzer';

let worker: PythonWorker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SafePaste AI');
  context.subscriptions.push(output);

  const scriptPath = path.join(
    context.extensionPath,
    'python-worker',
    'worker.py'
  );
  
  // Config value rather than a hardcoded "python3" so this works on
  // Windows (often "python") without code changes — a one-line setting,
  // not a feature, so it doesn't fight the "avoid complexity" goal.
  const pythonExecutable = vscode.workspace
    .getConfiguration('safepaste')
    .get<string>('pythonPath', 'python3');

  worker = new PythonWorker(scriptPath, pythonExecutable, output);

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

    const chunks = chunkRepository(folder.uri.fsPath);
    output.appendLine(`Chunked ${chunks.length} function(s). Sending to Python worker for embedding...`);

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
      vscode.window.showInformationMessage(
        result.failedChunks.length > 0
          ? `SafePaste: indexed ${result.chunksIndexed} chunk(s), ${result.failedChunks.length} skipped. See output panel.`
          : `SafePaste: indexed ${result.chunksIndexed} chunk(s).`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Indexing failed: ${message}`);
      vscode.window.showErrorMessage(`SafePaste indexing error: ${message}`);
    }
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

      // reportErrorsToUser: true — the user explicitly invoked this
      // command, so if something goes wrong (no workspace, worker
      // crashed, etc.) they should see an error message about it.
      // checkDuplicates: true — unconditional, same as before Milestone 4:
      // a deliberate selection always gets the full check, unlike the
      // automatic paste path below which gates duplicate-checking on
      // length.
      await analyzePastedCode(selectedText, editor!.document.languageId, {
        reportErrorsToUser: true,
        checkDuplicates: true,
      });
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
      _ranges: readonly vscode.Range[],
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
      // checkDuplicates is gated by length, but safety analysis is not:
      // duplicate detection needs enough text for a meaningful embedding,
      // but a short snippet can still be dangerous (`eval(x)` is 7
      // characters), so it would be wrong to skip safety analysis on the
      // same threshold.
      void analyzePastedCode(pastedText, document.languageId, {
        reportErrorsToUser: false,
        checkDuplicates: pastedText.trim().length >= MIN_PASTE_LENGTH_TO_CHECK,
      });

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

      if (result.matches.length === 0) {
        output.appendLine('No significant duplicates found.');
      } else {
        output.appendLine(`Found ${result.matches.length} possible duplicate(s):\n`);
        for (const match of result.matches) {
          output.appendLine(
            `— ${match.name}  (${match.filePath}:${match.startLine}-${match.endLine})  similarity=${match.similarity}`
          );
        }
      }
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
   * Milestone 4 entry point, used by both the manual command and the
   * automatic paste handler. Runs safety analysis (local, synchronous,
   * instant — no worker involved) and, if requested, duplicate detection
   * (async, via the unchanged existing worker flow), then shows exactly
   * one combined notification — or none at all if both are clean,
   * extending Milestone 3's silence rule to safety findings too.
   */
  async function analyzePastedCode(
    code: string,
    languageId: string,
    options: { reportErrorsToUser: boolean; checkDuplicates: boolean }
  ): Promise<void> {
    const safetyFindings = analyzeSafety(code, languageId);

    const duplicateResult = options.checkDuplicates
      ? await runDuplicateCheck(code, options.reportErrorsToUser)
      : undefined;

    showCombinedNotification(safetyFindings, duplicateResult);
  }

  function showCombinedNotification(
    safetyFindings: SafetyFinding[],
    duplicateResult: CheckDuplicatesResult | undefined
  ): void {
    const hasSafetyIssues = safetyFindings.length > 0;
    const hasDuplicates = !!duplicateResult && duplicateResult.matches.length > 0;

    if (!hasSafetyIssues && !hasDuplicates) {
      return; // silence — nothing to report
    }

    const parts: string[] = [];

    if (hasSafetyIssues) {
      output.appendLine(`Found ${safetyFindings.length} safety issue(s):\n`);
      for (const finding of safetyFindings) {
        output.appendLine(`— [${finding.ruleId}] line ${finding.line}: ${finding.message}`);
      }
      const ruleIds = Array.from(new Set(safetyFindings.map((f) => f.ruleId))).join(', ');
      parts.push(`${safetyFindings.length} safety issue(s) (${ruleIds})`);
    }

    if (hasDuplicates) {
      const top = duplicateResult!.matches[0];
      parts.push(`similar code already exists (${top.name}, ${top.filePath}:${top.startLine})`);
    }

    vscode.window.showWarningMessage(`⚠ ${parts.join(' — ')}. See output panel.`);
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
