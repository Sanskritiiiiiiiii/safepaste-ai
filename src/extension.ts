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

let worker: PythonWorker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SafePaste AI');
  context.subscriptions.push(output);

  // const scriptPath = path.join(context.extensionPath, '..', 'python-worker', 'worker.py');
  output.appendLine(`Extension path = ${context.extensionPath}`);

  const scriptPath = path.join(
      context.extensionPath,
      "python-worker",
      "worker.py"
  );

  output.appendLine(`Python worker = ${scriptPath}`);


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

      const storageDir = getStorageDir(context);
      output.show(true);
      output.appendLine('Checking selection for duplicates...');

      try {
        const result = await worker!.send<CheckDuplicatesResult>('check_duplicates', {
          storageDir,
          code: selectedText,
          topK: 5,
        } satisfies CheckDuplicatesPayload);

        if (result.matches.length === 0) {
          output.appendLine('No significant duplicates found.');
          vscode.window.showInformationMessage('SafePaste: no significant duplicates found.');
          return;
        }

        output.appendLine(`Found ${result.matches.length} possible duplicate(s):\n`);
        for (const match of result.matches) {
          output.appendLine(
            `— ${match.name}  (${match.filePath}:${match.startLine}-${match.endLine})  similarity=${match.similarity}`
          );
        }
        vscode.window.showWarningMessage(
          `SafePaste: found ${result.matches.length} similar function(s) already in this repo. See output panel.`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`Duplicate check failed: ${message}`);
        vscode.window.showErrorMessage(`SafePaste duplicate check error: ${message}`);
      }
    }
  );

  context.subscriptions.push(checkDuplicatesCommand);
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
