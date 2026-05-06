import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildKubeconfigEnv,
  clearAllEphemeralKubeconfigs,
  clearEphemeralKubeconfig,
  kubeconfigPath,
  renderKubeconfig,
  sweepOrphanKubeconfigs,
  writeEphemeralKubeconfig,
} from "../src/plugins/kubeconfig.ts";

/**
 * Each test gets its own temp HSH_HOME so the suite never touches the real
 * `~/.hsh`. `HSH_HOME` is the supported override — see `src/config/store.ts`.
 */

const realHshHome = process.env.HSH_HOME;
let tmpHshHome: string;

beforeEach(() => {
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-kube-test-"));
  process.env.HSH_HOME = tmpHshHome;
});

afterEach(() => {
  if (realHshHome !== undefined) {
    process.env.HSH_HOME = realHshHome;
  } else {
    delete process.env.HSH_HOME;
  }
  rmSync(tmpHshHome, { recursive: true, force: true });
});

describe("renderKubeconfig", () => {
  test("emits a valid single-context kubeconfig", () => {
    const yaml = renderKubeconfig({
      contextName: "prod-cluster",
      server: "https://gw.example.com:8443",
      token: "abc.def.ghi",
    });

    expect(yaml).toContain('current-context: "prod-cluster"');
    expect(yaml).toContain('- name: "hsh-prod-cluster"');
    expect(yaml).toContain('server: "https://gw.example.com:8443"');
    expect(yaml).toContain("insecure-skip-tls-verify: true");
    expect(yaml).toContain('token: "abc.def.ghi"');
    expect(yaml).toContain('cluster: "hsh-prod-cluster"');
    expect(yaml).toContain('user: "hsh-prod-cluster"');
    expect(yaml).toContain('- name: "prod-cluster"');
    expect(yaml.endsWith("\n")).toBe(true);
  });

  test("includes namespace when provided", () => {
    const yaml = renderKubeconfig({
      contextName: "ctx",
      server: "https://x",
      token: "t",
      namespace: "kube-system",
    });
    expect(yaml).toContain('namespace: "kube-system"');
  });

  test("omits namespace key when not provided", () => {
    const yaml = renderKubeconfig({
      contextName: "ctx",
      server: "https://x",
      token: "t",
    });
    expect(yaml).not.toContain("namespace:");
  });

  test("escapes embedded double-quotes and backslashes safely", () => {
    const yaml = renderKubeconfig({
      contextName: 'weird"name\\with-stuff',
      server: "https://x",
      token: 't"k\\n',
    });
    // Backslashes doubled, quotes escaped
    expect(yaml).toContain(`current-context: "weird\\"name\\\\with-stuff"`);
    expect(yaml).toContain(`token: "t\\"k\\\\n"`);
  });
});

describe("writeEphemeralKubeconfig", () => {
  test("writes the file under ~/.hsh/kube/ with mode 0600 and atomic semantics", () => {
    const path = writeEphemeralKubeconfig("prod-cluster", {
      contextName: "prod-cluster",
      server: "https://gw.example.com:8443",
      token: "tok",
    });

    expect(path).toBe(join(tmpHshHome, "kube", "prod-cluster.yaml"));
    expect(existsSync(path)).toBe(true);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    const content = readFileSync(path, "utf-8");
    expect(content).toContain('server: "https://gw.example.com:8443"');
  });

  test("sanitises connection names with filesystem-unsafe characters", () => {
    const path = writeEphemeralKubeconfig("weird/name with spaces!", {
      contextName: "weird/name with spaces!",
      server: "https://x",
      token: "t",
    });
    // Slashes, spaces, and ! all become underscores.
    expect(path).toContain("weird_name_with_spaces_.yaml");
  });

  test("subsequent writes overwrite atomically", () => {
    writeEphemeralKubeconfig("c1", {
      contextName: "c1",
      server: "https://a",
      token: "t1",
    });
    const path = writeEphemeralKubeconfig("c1", {
      contextName: "c1",
      server: "https://b",
      token: "t2",
    });
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('server: "https://b"');
    expect(content).toContain('token: "t2"');
    expect(content).not.toContain("https://a");
  });
});

describe("clearEphemeralKubeconfig", () => {
  test("removes the file for the named connection", () => {
    const path = writeEphemeralKubeconfig("c1", {
      contextName: "c1",
      server: "https://x",
      token: "t",
    });
    expect(existsSync(path)).toBe(true);
    clearEphemeralKubeconfig("c1");
    expect(existsSync(path)).toBe(false);
  });

  test("is a no-op when the file does not exist", () => {
    // Should not throw.
    clearEphemeralKubeconfig("never-existed");
  });
});

describe("clearAllEphemeralKubeconfigs", () => {
  test("removes every .yaml file under the kube dir", () => {
    const p1 = writeEphemeralKubeconfig("a", {
      contextName: "a",
      server: "https://x",
      token: "t",
    });
    const p2 = writeEphemeralKubeconfig("b", {
      contextName: "b",
      server: "https://x",
      token: "t",
    });
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
    clearAllEphemeralKubeconfigs();
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(false);
  });

  test("is safe when the kube dir does not exist yet", () => {
    // Don't create anything; just call.
    clearAllEphemeralKubeconfigs();
  });
});

describe("sweepOrphanKubeconfigs", () => {
  test("removes files older than 24h, keeps fresh ones", () => {
    const old = writeEphemeralKubeconfig("old", {
      contextName: "old",
      server: "https://x",
      token: "t",
    });
    const fresh = writeEphemeralKubeconfig("fresh", {
      contextName: "fresh",
      server: "https://x",
      token: "t",
    });

    // Backdate `old` by 25h
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(old, past, past);

    sweepOrphanKubeconfigs();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("buildKubeconfigEnv", () => {
  const hsh = "/home/u/.hsh/kube/prod.yaml";

  test("returns just the hsh path when KUBECONFIG is unset", () => {
    expect(buildKubeconfigEnv(hsh, undefined)).toBe(hsh);
  });

  test("returns just the hsh path when KUBECONFIG is empty/whitespace", () => {
    expect(buildKubeconfigEnv(hsh, "")).toBe(hsh);
    expect(buildKubeconfigEnv(hsh, "   ")).toBe(hsh);
  });

  test("prepends hsh path to existing KUBECONFIG", () => {
    expect(buildKubeconfigEnv(hsh, "/a/b:/c/d")).toBe(`${hsh}:/a/b:/c/d`);
  });

  test("does not duplicate the hsh path if already present", () => {
    expect(buildKubeconfigEnv(hsh, `${hsh}:/x`)).toBe(`${hsh}:/x`);
    expect(buildKubeconfigEnv(hsh, `/x:${hsh}`)).toBe(`${hsh}:/x`);
  });

  test("filters out empty segments produced by leading/trailing colons", () => {
    expect(buildKubeconfigEnv(hsh, ":/a:/b:")).toBe(`${hsh}:/a:/b`);
  });
});

describe("kubeconfigPath", () => {
  test("returns absolute path under ~/.hsh/kube/", () => {
    const p = kubeconfigPath("conn-1");
    expect(p).toBe(join(tmpHshHome, "kube", "conn-1.yaml"));
  });
});
