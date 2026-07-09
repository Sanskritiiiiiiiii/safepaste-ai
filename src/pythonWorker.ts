import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { RequestMessage, ResponseMessage } from './protocol';

/**
 * Owns the long-lived Python child process and speaks our JSON-lines
 * protocol to it over stdin/stdout.
 *
 * Why this exists: this is the entire Option C decision made real — no
 * HTTP server, no port, just a child process we own and talk to directly.
 * Everything about "how do we call the Python side" lives in this one file,
 * so the rest of the extension just calls `worker.send(type, payload)` and
 * doesn't know or care that a subprocess is involved.
 */
export class PythonWorker {
  private process: cp.ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private nextId = 1;

  constructor(
    private readonly scriptPath: string,
    private readonly pythonExecutable: string,
    private readonly output: vscode.OutputChannel
  ) {}

  /**
   * Sends a request and resolves once the worker replies with a matching id.
   * The id-matching (rather than assuming strict request/response ordering)
   * is what lets multiple requests be in flight without one blocking another.
   */
  async send<TResult = unknown>(type: string, payload: unknown): Promise<TResult> {
    this.ensureStarted();

    const id = String(this.nextId++);
    const message: RequestMessage = { id, type, payload };

    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as TResult),
        reject,
      });
      this.process!.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  /** Starts the process if it isn't already running (lazy restart after a crash). */
  private ensureStarted(): void {
    if (this.process && !this.process.killed) {
      return;
    }

    this.process = cp.spawn(this.pythonExecutable, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.process.stderr.on('data', (chunk: Buffer) => {
      this.output.appendLine(`[python-worker stderr] ${chunk.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      this.output.appendLine(`[python-worker] exited with code ${code}`);
      // Fail any requests still waiting on a reply from the dead process.
      for (const { reject } of this.pending.values()) {
        reject(new Error('Python worker process exited before responding'));
      }
      this.pending.clear();
      this.process = undefined;
      // Deliberately not auto-respawning here. The next `send()` call will
      // lazily start a fresh process via ensureStarted(). A crash-loop
      // watchdog is a real feature but not one Milestone 0 needs.
    });
  }

  private handleLine(line: string): void {
    let message: ResponseMessage;
    try {
      message = JSON.parse(line);
    } catch {
      this.output.appendLine(`[python-worker] received non-JSON line: ${line}`);
      return;
    }

    const waiting = this.pending.get(message.id);
    if (!waiting) {
      this.output.appendLine(`[python-worker] no pending request for id ${message.id}`);
      return;
    }
    this.pending.delete(message.id);

    if (message.ok) {
      waiting.resolve(message.result);
    } else {
      waiting.reject(new Error(`${message.error.code}: ${message.error.message}`));
    }
  }

  /** Called on extension deactivate so we don't leave orphaned processes running. */
  dispose(): void {
    this.process?.kill();
    this.process = undefined;
  }
}
