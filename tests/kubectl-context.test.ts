import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectContext,
  extractCurrentContext,
  readCurrentContextFromFile,
  readFlagValue,
} from "../src/plugins/kubectl-context.ts";

let tmpHome: string;
const realEnv = {
  KUBECONFIG: process.env.KUBECONFIG,
  HOME: process.env.HOME,
};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "hsh-kctx-"));
  process.env.HOME = tmpHome;
  delete process.env.KUBECONFIG;
});

afterEach(() => {
  if (realEnv.HOME !== undefined) process.env.HOME = realEnv.HOME;
  else delete process.env.HOME;
  if (realEnv.KUBECONFIG !== undefined) process.env.KUBECONFIG = realEnv.KUBECONFIG;
  else delete process.env.KUBECONFIG;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeKubeconfig(path: string, currentContext: string | null): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const body = currentContext
    ? `apiVersion: v1
kind: Config
current-context: ${currentContext}
clusters: []
users: []
contexts: []
`
    : `apiVersion: v1
kind: Config
clusters: []
users: []
contexts: []
`;
  writeFileSync(path, body);
}

describe("readFlagValue", () => {
  test("returns null when flag is absent", () => {
    expect(readFlagValue(["get", "pods"], "--context")).toBeNull();
  });

  test("supports separate form: --flag value", () => {
    expect(readFlagValue(["--context", "prod", "get", "pods"], "--context")).toBe("prod");
  });

  test("supports joined form: --flag=value", () => {
    expect(readFlagValue(["--context=prod", "get", "pods"], "--context")).toBe("prod");
  });

  test("stops at -- end-of-options marker", () => {
    expect(
      readFlagValue(["--", "--context", "prod"], "--context")
    ).toBeNull();
  });

  test("dangling separate flag (no value) returns null", () => {
    expect(readFlagValue(["--context"], "--context")).toBeNull();
  });

  test("first occurrence wins", () => {
    expect(
      readFlagValue(["--context", "first", "--context", "second"], "--context")
    ).toBe("first");
  });
});

describe("extractCurrentContext", () => {
  test("plain unquoted value", () => {
    expect(
      extractCurrentContext("apiVersion: v1\ncurrent-context: my-ctx\n")
    ).toBe("my-ctx");
  });

  test("double-quoted value", () => {
    expect(
      extractCurrentContext(`current-context: "my-ctx"\n`)
    ).toBe("my-ctx");
  });

  test("single-quoted value", () => {
    expect(
      extractCurrentContext(`current-context: 'my-ctx'\n`)
    ).toBe("my-ctx");
  });

  test("trailing comment is stripped", () => {
    expect(
      extractCurrentContext(`current-context: my-ctx   # was prod-ctx\n`)
    ).toBe("my-ctx");
  });

  test("returns null when current-context is missing", () => {
    expect(
      extractCurrentContext("apiVersion: v1\nkind: Config\n")
    ).toBeNull();
  });

  test("returns null for empty file", () => {
    expect(extractCurrentContext("")).toBeNull();
  });

  test("returns null when value is empty (current-context: )", () => {
    expect(extractCurrentContext("current-context: \n")).toBeNull();
  });

  test("ignores indented occurrences (only top-level wins)", () => {
    const yaml = `apiVersion: v1
kind: Config
clusters:
  - name: foo
    cluster:
      current-context: NOT-THIS
current-context: actual-ctx
`;
    expect(extractCurrentContext(yaml)).toBe("actual-ctx");
  });

  test("first top-level occurrence wins", () => {
    const yaml = `current-context: first
current-context: second
`;
    expect(extractCurrentContext(yaml)).toBe("first");
  });
});

describe("readCurrentContextFromFile", () => {
  test("returns null for non-existent file", () => {
    expect(readCurrentContextFromFile("/nonexistent/path")).toBeNull();
  });

  test("reads value from real file", () => {
    const path = join(tmpHome, "kubeconfig");
    writeKubeconfig(path, "ctx-from-file");
    expect(readCurrentContextFromFile(path)).toBe("ctx-from-file");
  });
});

describe("detectContext: priority chain", () => {
  test("--context flag wins over everything", () => {
    // Set up a real kubeconfig too — flag must still win.
    const path = join(tmpHome, ".kube", "config");
    writeKubeconfig(path, "from-default-file");
    process.env.KUBECONFIG = "/some/other/file";

    const result = detectContext(["--context", "from-flag", "get", "pods"]);
    expect(result.context).toBe("from-flag");
    expect(result.source).toBe("flag");
    expect(result.fileConsulted).toBeNull();
  });

  test("--context=value form (joined) is honored", () => {
    const result = detectContext(["--context=joined-ctx", "get", "pods"]);
    expect(result.context).toBe("joined-ctx");
    expect(result.source).toBe("flag");
  });

  test("--kubeconfig flag points at a specific file", () => {
    const path = join(tmpHome, "alt-kubeconfig");
    writeKubeconfig(path, "ctx-from-alt-file");

    const result = detectContext(["--kubeconfig", path, "get", "pods"]);
    expect(result.context).toBe("ctx-from-alt-file");
    expect(result.source).toBe("kubeconfig-flag");
    expect(result.fileConsulted).toBe(path);
  });

  test("--kubeconfig=value (joined) form is honored", () => {
    const path = join(tmpHome, "alt-kubeconfig");
    writeKubeconfig(path, "ctx-joined-flag");

    const result = detectContext([`--kubeconfig=${path}`, "get", "pods"]);
    expect(result.context).toBe("ctx-joined-flag");
    expect(result.source).toBe("kubeconfig-flag");
  });

  test("KUBECONFIG env: single file", () => {
    const path = join(tmpHome, "envconfig");
    writeKubeconfig(path, "ctx-from-env");
    process.env.KUBECONFIG = path;

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBe("ctx-from-env");
    expect(result.source).toBe("kubeconfig-env");
    expect(result.fileConsulted).toBe(path);
  });

  test("KUBECONFIG env: multiple files, first one with current-context wins", () => {
    const a = join(tmpHome, "a-config");
    const b = join(tmpHome, "b-config");
    writeKubeconfig(a, "from-a");
    writeKubeconfig(b, "from-b");
    process.env.KUBECONFIG = `${a}:${b}`;

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBe("from-a");
    expect(result.fileConsulted).toBe(a);
  });

  test("KUBECONFIG env: skips files without current-context, picks next", () => {
    const a = join(tmpHome, "no-ctx");
    const b = join(tmpHome, "has-ctx");
    writeKubeconfig(a, null); // no current-context
    writeKubeconfig(b, "from-b");
    process.env.KUBECONFIG = `${a}:${b}`;

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBe("from-b");
    expect(result.fileConsulted).toBe(b);
  });

  test("KUBECONFIG env: all files missing current-context → null", () => {
    const a = join(tmpHome, "a");
    writeKubeconfig(a, null);
    process.env.KUBECONFIG = a;

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBeNull();
    expect(result.source).toBe("kubeconfig-env");
  });

  test("KUBECONFIG env: nonexistent files in path are silently skipped", () => {
    const real = join(tmpHome, "real");
    writeKubeconfig(real, "real-ctx");
    process.env.KUBECONFIG = `/nonexistent:${real}`;

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBe("real-ctx");
  });

  test("default ~/.kube/config when KUBECONFIG unset", () => {
    const path = join(tmpHome, ".kube", "config");
    writeKubeconfig(path, "default-ctx");

    const result = detectContext(["get", "pods"]);
    expect(result.context).toBe("default-ctx");
    expect(result.source).toBe("default");
    expect(result.fileConsulted).toBe(path);
  });

  test("no kubeconfig anywhere → null + 'none' source (in-cluster case)", () => {
    // tmpHome has no .kube/config; KUBECONFIG is unset.
    const result = detectContext(["get", "pods"]);
    expect(result.context).toBeNull();
    expect(result.source).toBe("none");
    expect(result.fileConsulted).toBeNull();
  });

  test("--context after -- end-of-options is NOT consumed", () => {
    const path = join(tmpHome, ".kube", "config");
    writeKubeconfig(path, "default-ctx");

    // The -- means everything after is positional (a remote command, in
    // ssh's world). For kubectl, --context after -- isn't a flag. We
    // should fall back to the default file's current-context.
    const result = detectContext(["--", "--context", "ignored"]);
    expect(result.context).toBe("default-ctx");
    expect(result.source).toBe("default");
  });
});

describe("detectContext: regression tests", () => {
  test("empty argv falls through to default", () => {
    const path = join(tmpHome, ".kube", "config");
    writeKubeconfig(path, "default-ctx");
    expect(detectContext([]).context).toBe("default-ctx");
  });

  test("argv with only positional commands falls through to default", () => {
    const path = join(tmpHome, ".kube", "config");
    writeKubeconfig(path, "default-ctx");
    expect(detectContext(["get", "pods", "-A"]).context).toBe("default-ctx");
  });
});
