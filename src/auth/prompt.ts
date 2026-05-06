/**
 * Minimal terminal prompt helpers for `hsh login` against local-auth
 * gateways. Two functions:
 *
 *   - `promptLine(message)` — echoes typed characters, returns line on Enter.
 *   - `promptPassword(message)` — does NOT echo, returns line on Enter.
 *
 * Why hand-rolled instead of a dep? The PRD keeps hsh dependency-light
 * (only `chalk`/`boxen`/`ora`/`open` for UI). A 60-line raw-mode reader
 * is the right tradeoff vs. pulling in `@inquirer/password`.
 *
 * Behavior contract (matches typical readline UX):
 *   - Enter / CR → resolve with the buffer (without the newline)
 *   - Backspace / DEL → drop one char from the buffer
 *   - Ctrl-C (0x03) → reject with `PromptCancelledError` (caller exits 1)
 *   - Ctrl-D (0x04) on empty input → reject with `PromptCancelledError`
 *   - Other control chars (escape sequences, arrows, etc.) → ignored
 *
 * Streams are injected so tests can drive prompts deterministically
 * without touching a real TTY (Bun's testRunner has no TTY).
 */

export class PromptCancelledError extends Error {
  constructor(reason: string) {
    super(`prompt cancelled: ${reason}`);
    this.name = "PromptCancelledError";
  }
}

export interface PromptStreams {
  /** Where to read keypresses from. Real default: process.stdin. */
  input: NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => unknown;
    isTTY?: boolean;
    resume?: () => void;
    pause?: () => void;
  };
  /** Where to write the prompt + echoed characters. Real default: process.stderr. */
  output: NodeJS.WritableStream;
}

const DEFAULT_STREAMS: PromptStreams = {
  // input is set lazily inside prompt() — process.stdin in Bun isn't safe to
  // touch at module load (it gets locked into raw mode on the first access).
  input: undefined as unknown as PromptStreams["input"],
  output: process.stderr,
};

/**
 * Read a line from the terminal with characters echoed back. Used for
 * prompting the user's email — non-secret, normal terminal behavior.
 */
export function promptLine(
  message: string,
  streams: Partial<PromptStreams> = {},
): Promise<string> {
  return readWithEcho(message, /*echo=*/ true, streams);
}

/**
 * Read a line from the terminal WITHOUT echoing characters. Used for
 * password input. The user sees no feedback at all (no asterisks) —
 * matches `sudo`/`ssh` behavior on most platforms. Not showing
 * asterisks also avoids leaking the password length to a shoulder-surfer.
 *
 * On Enter, a single newline is written so the next output isn't on
 * the same line as the prompt.
 */
export function promptPassword(
  message: string,
  streams: Partial<PromptStreams> = {},
): Promise<string> {
  return readWithEcho(message, /*echo=*/ false, streams);
}

function readWithEcho(
  message: string,
  echo: boolean,
  partial: Partial<PromptStreams>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = partial.input ?? DEFAULT_STREAMS.input ?? process.stdin;
    const output = partial.output ?? DEFAULT_STREAMS.output;

    output.write(message);

    let buffer = "";
    let cleaned = false;
    // Tiny state machine for ANSI/CSI escape sequences (arrow keys,
    // function keys, etc.). We don't interpret them — just swallow
    // them so they don't pollute the buffer.
    //   0 = normal
    //   1 = saw ESC, next byte is intermediate
    //   2 = saw ESC + [ or O, swallow until a final byte (0x40-0x7E)
    let escState: 0 | 1 | 2 = 0;

    // Set raw mode if the stream supports it. In tests we feed a
    // PassThrough stream which has no setRawMode — that's fine, we
    // just read newline-terminated chunks instead.
    const wasRaw = isRaw(input);
    if (typeof input.setRawMode === "function" && input.isTTY) {
      try {
        input.setRawMode(true);
      } catch {
        // Some environments (CI, container without a TTY) reject
        // setRawMode; we just degrade to line mode and characters
        // will echo by default. Password input in this mode is
        // dangerous, so for password prompts we refuse outright.
        if (!echo) {
          reject(
            new Error(
              "cannot read password without a TTY (raw mode unavailable)",
            ),
          );
          return;
        }
      }
    }

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      if (typeof input.setRawMode === "function" && input.isTTY) {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // best effort
        }
      }
      // Pause the stream so any data written between this prompt and
      // the next one is buffered, not dropped on the floor. The next
      // prompt's resume() will release the buffer in order. Without
      // this, two back-to-back prompts (e.g. email then password) lose
      // bytes written by callers (or tests) before the second prompt's
      // listener attaches.
      if (typeof input.pause === "function") {
        try {
          input.pause();
        } catch {
          // best effort
        }
      }
    };

    /**
     * IMPORTANT: callers (the byte loop in onData) MUST call `pushBack`
     * BEFORE invoking finish/cancel. Reason: `unshift()` re-emits the
     * pushed data synchronously to the still-attached `data` listener,
     * which causes the current onData call to recursively re-process
     * the rest of the buffer for the same prompt. cleanup() detaches
     * the listener but only AFTER the unshift would already have fired.
     *
     * The sequence we want is:
     *   1. byte loop sees terminator (\n), captures the rest into a
     *      local Buffer
     *   2. cleanup() — detach listener, pause stream
     *   3. unshift() — buffered for the NEXT prompt's listener
     *   4. resolve() with the line we collected
     *
     * To keep that order without touching every call site, finish()
     * accepts an optional pendingPushBack closure that runs AFTER
     * cleanup but BEFORE resolve.
     */
    const finish = (value: string, pendingPushBack?: () => void) => {
      cleanup();
      pendingPushBack?.();
      output.write("\n");
      resolve(value);
    };

    const cancel = (reason: string, pendingPushBack?: () => void) => {
      cleanup();
      pendingPushBack?.();
      output.write("\n");
      reject(new PromptCancelledError(reason));
    };

    /**
     * Build a closure that, when invoked, pushes any unconsumed bytes
     * back onto the stream so the next prompt (or other consumer)
     * sees them. Without this, when stdin delivers
     * "user@example.com\npassword\n" in a single chunk (which Bun does
     * for piped/heredoc input), the password bytes would be lost — we
     * `return` on the first '\n', dropping the rest of the buffer on
     * the floor.
     *
     * Critically, we capture the slice IMMEDIATELY (before cleanup
     * pauses the stream) but defer the unshift until after the
     * listener is removed — otherwise the unshifted data is re-emitted
     * synchronously to the still-attached listener and gets reprocessed
     * by the current prompt instead of buffered for the next one.
     */
    const makePushBack = (buf: Buffer, fromIndex: number): (() => void) | undefined => {
      if (fromIndex >= buf.length) return undefined;
      const rest = buf.subarray(fromIndex);
      return () => {
        const s = input as unknown as { unshift?: (chunk: Buffer) => void };
        if (typeof s.unshift === "function") {
          try {
            s.unshift(rest);
          } catch {
            // Some streams (paused TTYs) reject unshift; we accept the
            // loss because TTY input never delivers a multi-line chunk
            // in raw mode anyway. The unshift path matters for piped
            // stdin (heredocs, test PassThroughs).
          }
        }
      };
    };

    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      for (let i = 0; i < buf.length; i++) {
        const byte = buf[i];
        // ANSI escape state machine — swallow arrow keys, function keys,
        // and other CSI/SS3 sequences without leaking the bracketed
        // bytes into the buffer.
        if (escState === 1) {
          // Just saw ESC. Either a CSI introducer ([) or SS3 (O), or a
          // standalone ESC press (in which case the next byte is a
          // normal char and we shouldn't swallow it). We only swallow
          // [ or O followed by their final byte.
          if (byte === 0x5b /* [ */ || byte === 0x4f /* O */) {
            escState = 2;
            continue;
          }
          // Lone ESC — ignore it and re-process the byte as normal.
          escState = 0;
          // fall through to normal handling
        } else if (escState === 2) {
          // Inside a CSI/SS3 sequence. Final byte is in range 0x40-0x7E.
          // Parameter and intermediate bytes (0x30-0x3F, 0x20-0x2F) come
          // before it; we swallow them all.
          if (byte >= 0x40 && byte <= 0x7e) {
            escState = 0;
          }
          continue;
        }

        // Ctrl-C
        if (byte === 0x03) {
          return cancel("user pressed Ctrl-C", makePushBack(buf, i + 1));
        }
        // Ctrl-D on empty buffer (EOF). Non-empty Ctrl-D is ignored —
        // canonical-mode shells treat Ctrl-D mid-line as "submit" but
        // raw mode here is closer to readline, where Enter is the
        // submit key.
        if (byte === 0x04) {
          if (buffer.length === 0) {
            return cancel("EOF", makePushBack(buf, i + 1));
          }
          continue;
        }
        // Enter / CR / LF
        if (byte === 0x0d || byte === 0x0a) {
          return finish(buffer, makePushBack(buf, i + 1));
        }
        // Backspace (0x7f DEL on Unix, 0x08 BS on Windows). Erase one
        // char from the buffer; if echoing, repaint by writing
        // "\b \b" (move-back, space, move-back).
        if (byte === 0x7f || byte === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (echo) output.write("\b \b");
          }
          continue;
        }
        // ESC starts an escape sequence — enter state 1 to decide what
        // kind on the next byte.
        if (byte === 0x1b) {
          escState = 1;
          continue;
        }
        // Skip other control chars (Ctrl-A through Ctrl-Z minus the
        // ones already handled above).
        if (byte < 0x20) continue;

        const ch = String.fromCharCode(byte);
        buffer += ch;
        if (echo) output.write(ch);
      }
    };

    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    input.on("data", onData);
    input.on("error", onError);
    if (typeof input.resume === "function") input.resume();
  });
}

function isRaw(input: PromptStreams["input"]): boolean {
  // Node's tty.ReadStream exposes isRaw; Bun matches.
  return Boolean((input as unknown as { isRaw?: boolean }).isRaw);
}
