/**
 * tests/daemon-download.test.ts — unit tests for the pieces of
 * scripts/lib/daemon-download that don't touch the network.
 *
 * The downloader has two halves:
 *
 *   - Pure helpers: parseSha256sums, hexSha256, daemonAssetName.
 *     Cheap to test, no network, no fs. We hit those directly.
 *
 *   - I/O orchestration: resolveRelease, downloadAsset. These hit
 *     GitHub. We don't mock-network them in unit tests — they're
 *     covered by the actual `bun run build` happy-path run that the
 *     RD-227 ticket marks as the acceptance test. Mocking fetch
 *     here would only test that the mock matches our code, not
 *     that the code matches GitHub.
 */

import { describe, expect, test } from "bun:test";
import { daemonAssetName, parseSha256sums } from "../scripts/lib/daemon-download";

describe("daemonAssetName", () => {
  test("Linux/amd64 -> hsh-tunneld-linux-amd64", () => {
    expect(daemonAssetName({ goos: "linux", goarch: "amd64" })).toBe(
      "hsh-tunneld-linux-amd64",
    );
  });
  test("Linux/arm64 -> hsh-tunneld-linux-arm64", () => {
    expect(daemonAssetName({ goos: "linux", goarch: "arm64" })).toBe(
      "hsh-tunneld-linux-arm64",
    );
  });
  test("Darwin/arm64 -> hsh-tunneld-darwin-arm64", () => {
    expect(daemonAssetName({ goos: "darwin", goarch: "arm64" })).toBe(
      "hsh-tunneld-darwin-arm64",
    );
  });
  test("Windows targets get .exe suffix", () => {
    expect(daemonAssetName({ goos: "windows", goarch: "amd64" })).toBe(
      "hsh-tunneld-windows-amd64.exe",
    );
    expect(daemonAssetName({ goos: "windows", goarch: "arm64" })).toBe(
      "hsh-tunneld-windows-arm64.exe",
    );
  });
});

describe("parseSha256sums", () => {
  test("parses a well-formed file", () => {
    const body = [
      "a23bca5b...  hsh-tunneld-linux-amd64",
      "b34cda6c...  hsh-tunneld-linux-arm64",
      "c45deb7d...  install.sh",
      "",
    ].join("\n");
    const m = parseSha256sums(body);
    expect(m.get("hsh-tunneld-linux-amd64")).toBe("a23bca5b...");
    expect(m.get("hsh-tunneld-linux-arm64")).toBe("b34cda6c...");
    expect(m.get("install.sh")).toBe("c45deb7d...");
    expect(m.size).toBe(3);
  });
  test("tolerates the GNU sha256sum -b * marker", () => {
    const body = "deadbeef  *hsh-tunneld-windows-amd64.exe\n";
    const m = parseSha256sums(body);
    expect(m.get("hsh-tunneld-windows-amd64.exe")).toBe("deadbeef");
  });
  test("ignores blank lines and comments", () => {
    const body = "\n# comment\ndeadbeef  install.sh\n";
    const m = parseSha256sums(body);
    expect(m.size).toBe(1);
    expect(m.get("install.sh")).toBe("deadbeef");
  });
  test("lowercases hex (matches what crypto.createHash returns)", () => {
    const body = "DEADBEEF  install.sh\n";
    const m = parseSha256sums(body);
    expect(m.get("install.sh")).toBe("deadbeef");
  });
  test("drops malformed lines (no crash)", () => {
    const body = "only-one-field\n";
    const m = parseSha256sums(body);
    expect(m.size).toBe(0);
  });
});

describe("isLatest", () => {
  test("recognises 'latest' case-insensitively", async () => {
    const { isLatest } = await import("../src/daemon-version");
    expect(isLatest("latest")).toBe(true);
    expect(isLatest("LATEST")).toBe(true);
    expect(isLatest(" Latest \t")).toBe(true);
    expect(isLatest("v1.0.0")).toBe(false);
    expect(isLatest("")).toBe(false);
  });
});
