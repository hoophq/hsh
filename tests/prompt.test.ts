import { describe, expect, test } from "bun:test";
import { PassThrough } from "stream";
import {
  promptLine,
  promptPassword,
  PromptCancelledError,
} from "../src/auth/prompt.ts";

/**
 * Tests for the raw-mode terminal prompt helpers used by `hsh login`
 * against local-auth gateways. The streams are injected so we don't
 * need a real TTY (Bun's testRunner has none).
 *
 * Behavior contract under test:
 *   - Enter (CR or LF) submits the buffer.
 *   - Backspace / DEL erases one char; cannot underflow.
 *   - Ctrl-C rejects with PromptCancelledError.
 *   - Ctrl-D on empty input rejects with PromptCancelledError.
 *   - Ctrl-D on non-empty input is ignored (Enter is the submit key).
 *   - Other control chars (0x01-0x1F except CR/LF) are ignored.
 *   - Echo mode prints typed chars; password mode does not.
 *   - Backspace in echo mode emits "\b \b" to repaint the line.
 */

function makeStreams() {
  // Plain PassThrough — no setRawMode, no isTTY → readWithEcho's raw-mode
  // branch is skipped, which matches the "in tests" contract of the helper.
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output };
}

function captureOutput(s: PassThrough): { read: () => string } {
  const chunks: Buffer[] = [];
  s.on("data", (c) => chunks.push(c as Buffer));
  return { read: () => Buffer.concat(chunks).toString("utf-8") };
}

describe("promptLine (echoed)", () => {
  test("returns the buffer on Enter (LF)", async () => {
    const { input, output } = makeStreams();
    const out = captureOutput(output);
    const p = promptLine("Email: ", { input, output });
    input.write("alice@example.com\n");
    expect(await p).toBe("alice@example.com");
    // Prompt label was written, characters were echoed back, trailing newline.
    expect(out.read()).toContain("Email: ");
    expect(out.read()).toContain("alice@example.com");
  });

  test("returns the buffer on CR", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write("hi\r");
    expect(await p).toBe("hi");
  });

  test("backspace deletes one char and repaints with '\\b \\b'", async () => {
    const { input, output } = makeStreams();
    const out = captureOutput(output);
    const p = promptLine("> ", { input, output });
    input.write("ab");
    input.write(Buffer.from([0x7f])); // DEL
    input.write("c\n");
    expect(await p).toBe("ac");
    // Confirm the repaint sequence was emitted on backspace.
    expect(out.read()).toContain("\b \b");
  });

  test("backspace on empty buffer is a no-op (no underflow)", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write(Buffer.from([0x7f, 0x7f, 0x7f])); // 3 DELs into empty
    input.write("ok\n");
    expect(await p).toBe("ok");
  });

  test("Ctrl-C rejects with PromptCancelledError", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write("partial");
    input.write(Buffer.from([0x03])); // Ctrl-C
    await expect(p).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("Ctrl-D on empty buffer rejects (EOF)", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write(Buffer.from([0x04])); // Ctrl-D
    await expect(p).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("Ctrl-D mid-buffer is ignored (Enter still submits)", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write("ab");
    input.write(Buffer.from([0x04])); // Ctrl-D — should not submit
    input.write("c\n");
    expect(await p).toBe("abc");
  });

  test("control characters (escape, arrows) are ignored", async () => {
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    // ESC + [ + A = up arrow. None of these should make it into the buffer.
    input.write(Buffer.from([0x1b, 0x5b, 0x41]));
    input.write("hello\n");
    expect(await p).toBe("hello");
  });

  test("handles UTF-8 bytes that are >= 0x20 (printable ASCII only)", async () => {
    // The current implementation accepts any byte >= 0x20 as a char.
    // High bytes (UTF-8 continuations) come through as-is. This is fine
    // for ASCII-only inputs (emails, passwords without non-ASCII), which
    // is the documented constraint.
    const { input, output } = makeStreams();
    const p = promptLine("> ", { input, output });
    input.write("plain-ascii_123!@#\n");
    expect(await p).toBe("plain-ascii_123!@#");
  });
});

describe("multi-prompt sequencing (regression)", () => {
  test("two back-to-back prompts split a single multi-line chunk correctly", async () => {
    // This is the exact failure mode hit live: Bun's stdin delivers
    // piped input in a single 'data' event (e.g. heredocs send
    // "user@example.com\npassword\n" all at once). Without unshift()
    // of the trailing bytes after \n, the second prompt gets nothing
    // and the process hangs (or, with paused stream, the bytes are
    // dropped and the prompt waits forever).
    const { input, output } = makeStreams();
    const p1 = promptLine("Email: ", { input, output });
    input.write("alice@example.com\nhunter2\n");
    const email = await p1;
    expect(email).toBe("alice@example.com");

    // Now start the second prompt. The "hunter2\n" bytes should still
    // be available (pushed back via unshift).
    const p2 = promptPassword("Password: ", { input, output });
    const password = await p2;
    expect(password).toBe("hunter2");
  });

  test("three sequential prompts from a single chunk", async () => {
    const { input, output } = makeStreams();
    input.write("a\nbb\nccc\n");
    expect(await promptLine("> ", { input, output })).toBe("a");
    expect(await promptLine("> ", { input, output })).toBe("bb");
    expect(await promptLine("> ", { input, output })).toBe("ccc");
  });
});

describe("promptPassword (silent)", () => {
  test("returns the buffer on Enter without echoing characters", async () => {
    const { input, output } = makeStreams();
    const out = captureOutput(output);
    const p = promptPassword("Password: ", { input, output });
    input.write("hunter2\n");
    expect(await p).toBe("hunter2");

    // Prompt label is the only thing on the output BEFORE the trailing
    // newline. The password chars must NOT be in the captured output.
    const captured = out.read();
    expect(captured).toContain("Password: ");
    expect(captured).not.toContain("hunter2");
  });

  test("backspace works but is not visible (no '\\b \\b' repaint)", async () => {
    const { input, output } = makeStreams();
    const out = captureOutput(output);
    const p = promptPassword("Password: ", { input, output });
    input.write("abc");
    input.write(Buffer.from([0x7f])); // DEL one
    input.write("d\n");
    expect(await p).toBe("abd");
    // Crucial: no repaint sequence, so nothing leaks the typed length.
    expect(out.read()).not.toContain("\b \b");
  });

  test("Ctrl-C rejects mid-password", async () => {
    const { input, output } = makeStreams();
    const p = promptPassword("Password: ", { input, output });
    input.write("secret");
    input.write(Buffer.from([0x03]));
    await expect(p).rejects.toBeInstanceOf(PromptCancelledError);
  });
});
