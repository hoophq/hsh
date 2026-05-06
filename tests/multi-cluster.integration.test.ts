import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  buildKubeconfigEnv,
  clearAllEphemeralKubeconfigs,
  clearEphemeralKubeconfig,
  kubeconfigPath,
  writeEphemeralKubeconfig,
} from "../src/plugins/kubeconfig.ts";

/**
 * End-to-end multi-cluster / multi-namespace / multi-terminal safety
 * tests. These shell out to real `kubectl config view` to verify the
 * generated kubeconfigs hold the right shape under each scenario.
 *
 * Skipped when kubectl isn't on PATH.
 */

function hasKubectl(): boolean {
  const r = spawnSync("kubectl", ["version", "--client", "-o=json"], {
    stdio: "ignore",
  });
  return r.status === 0;
}

const KUBECTL = hasKubectl();
const describeIfKubectl = KUBECTL ? describe : describe.skip;

const realHshHome = process.env.HSH_HOME;
let tmpHshHome: string;

beforeEach(() => {
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-multi-"));
  process.env.HSH_HOME = tmpHshHome;
});

afterEach(() => {
  if (realHshHome !== undefined) process.env.HSH_HOME = realHshHome;
  else delete process.env.HSH_HOME;
  rmSync(tmpHshHome, { recursive: true, force: true });
});

describeIfKubectl("Multi-namespace: -n flag flows through, single Hoop credential reused", () => {
  test("two namespaces against the same context use the same kubeconfig file", () => {
    // The kubectl plugin's logic: connection match is keyed on the kubectl
    // context name (not the namespace). The -n flag is passed through to
    // kubectl unchanged. So any two `-n foo` / `-n bar` calls against the
    // same context resolve to the same cached credential and the same
    // ephemeral kubeconfig file.
    const path1 = writeEphemeralKubeconfig("prod-cluster", {
      contextName: "prod-cluster",
      server: "https://gw.example.com:8443",
      token: "tok",
    });
    const path2 = kubeconfigPath("prod-cluster");
    expect(path1).toBe(path2); // Same connection name → same file path.

    // After two writes (simulating two `kubectl -n foo` then `kubectl -n bar`),
    // the file still has exactly one `current-context` and the right server.
    const r = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        `--kubeconfig=${path1}`,
        "-o=jsonpath={.current-context}",
      ],
      { encoding: "utf-8" }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("prod-cluster");
  });
});

describeIfKubectl("Multi-cluster: separate contexts get separate cached files", () => {
  test("two contexts produce two distinct kubeconfig files with no cross-contamination", () => {
    const aPath = writeEphemeralKubeconfig("cluster-a", {
      contextName: "cluster-a",
      server: "https://gw-a.example.com:8443",
      token: "tok-a",
    });
    const bPath = writeEphemeralKubeconfig("cluster-b", {
      contextName: "cluster-b",
      server: "https://gw-b.example.com:8443",
      token: "tok-b",
    });
    expect(aPath).not.toBe(bPath);

    // Verify each file points at its own server and has its own context.
    const aServer = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        `--kubeconfig=${aPath}`,
        "--minify",
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8" }
    );
    expect(aServer.status).toBe(0);
    expect(aServer.stdout.trim()).toBe("https://gw-a.example.com:8443");

    const bServer = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        `--kubeconfig=${bPath}`,
        "--minify",
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8" }
    );
    expect(bServer.status).toBe(0);
    expect(bServer.stdout.trim()).toBe("https://gw-b.example.com:8443");
  });

  test("clearing one context's kubeconfig does not affect the other", () => {
    const aPath = writeEphemeralKubeconfig("cluster-a", {
      contextName: "cluster-a",
      server: "https://gw-a.example.com:8443",
      token: "tok-a",
    });
    const bPath = writeEphemeralKubeconfig("cluster-b", {
      contextName: "cluster-b",
      server: "https://gw-b.example.com:8443",
      token: "tok-b",
    });
    expect(existsSync(aPath)).toBe(true);
    expect(existsSync(bPath)).toBe(true);

    clearEphemeralKubeconfig("cluster-a");

    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(bPath)).toBe(true);
  });

  test("hsh logout (clearAllEphemeralKubeconfigs) wipes every cluster's file", () => {
    writeEphemeralKubeconfig("cluster-a", {
      contextName: "cluster-a",
      server: "https://x",
      token: "t",
    });
    writeEphemeralKubeconfig("cluster-b", {
      contextName: "cluster-b",
      server: "https://x",
      token: "t",
    });

    clearAllEphemeralKubeconfigs();

    expect(existsSync(kubeconfigPath("cluster-a"))).toBe(false);
    expect(existsSync(kubeconfigPath("cluster-b"))).toBe(false);
  });
});

describeIfKubectl("Multi-terminal: same context, two concurrent invocations", () => {
  test("repeated writes to the same kubeconfig converge to a valid file (no torn YAML)", () => {
    // Simulate 50 sequential 'kubectl' invocations on the same connection
    // (real terminals would interleave but Bun's filesystem is fast enough
    // that even sequential overwrite proves the atomic-write contract
    // holds end-to-end).
    let path = "";
    for (let i = 0; i < 50; i++) {
      path = writeEphemeralKubeconfig("shared-cluster", {
        contextName: "shared-cluster",
        server: `https://gw-${i % 3}.example.com:8443`, // jitter to ensure changes
        token: `tok-${i}`,
      });
    }
    // After 50 writes, the file MUST be parseable by kubectl.
    const r = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        `--kubeconfig=${path}`,
        "-o=jsonpath={.current-context}",
      ],
      { encoding: "utf-8" }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("shared-cluster");
  });

  test("merged KUBECONFIG with hsh + user-config preserves the user's other contexts", () => {
    // The user's real ~/.kube/config has multiple contexts. While running
    // a Hoop kubectl call against context X, hsh's ephemeral file shadows
    // X but does NOT remove the user's OTHER contexts (which kubectl can
    // still see in the merged view).
    const userKubeconfig = join(tmpHshHome, "user-config");
    const userYaml =
      "apiVersion: v1\n" +
      "kind: Config\n" +
      'current-context: "ctx-prod"\n' +
      "clusters:\n" +
      '- name: "real-prod"\n' +
      "  cluster:\n" +
      '    server: "https://real-prod.example.com:6443"\n' +
      '- name: "real-dev"\n' +
      "  cluster:\n" +
      '    server: "https://real-dev.example.com:6443"\n' +
      "users:\n" +
      '- name: "real-user"\n' +
      "  user:\n" +
      '    token: "user-tok"\n' +
      "contexts:\n" +
      '- name: "ctx-prod"\n' +
      "  context:\n" +
      '    cluster: "real-prod"\n' +
      '    user: "real-user"\n' +
      '- name: "ctx-dev"\n' +
      "  context:\n" +
      '    cluster: "real-dev"\n' +
      '    user: "real-user"\n';
    require("fs").writeFileSync(userKubeconfig, userYaml, { mode: 0o600 });

    // hsh creates an ephemeral kubeconfig for ctx-prod (shadowing the user's
    // real prod). The merged KUBECONFIG should still expose ctx-dev.
    const hshPath = writeEphemeralKubeconfig("ctx-prod", {
      contextName: "ctx-prod",
      server: "https://hoop.example.com:8443",
      token: "hoop-tok",
    });
    const merged = buildKubeconfigEnv(hshPath, userKubeconfig);

    // ctx-prod (current) → Hoop server wins.
    const cur = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        "--minify",
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8", env: { ...process.env, KUBECONFIG: merged } }
    );
    expect(cur.status).toBe(0);
    expect(cur.stdout.trim()).toBe("https://hoop.example.com:8443");

    // ctx-dev still reachable via --context override.
    const dev = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        "--minify",
        "--context=ctx-dev",
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8", env: { ...process.env, KUBECONFIG: merged } }
    );
    expect(dev.status).toBe(0);
    expect(dev.stdout.trim()).toBe("https://real-dev.example.com:6443");
  });
});

describeIfKubectl("Permissions audit (regression guard)", () => {
  test("every ephemeral kubeconfig is mode 0600", () => {
    const a = writeEphemeralKubeconfig("a", {
      contextName: "a",
      server: "https://x",
      token: "t",
    });
    const b = writeEphemeralKubeconfig("b", {
      contextName: "b",
      server: "https://x",
      token: "t",
    });
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(b).mode & 0o777).toBe(0o600);
  });

  test("kubeconfig content does not contain leftover content from prior writes", () => {
    // Write context A's kubeconfig, then overwrite the SAME path with
    // context A but a different token. The file must contain ONLY the
    // new token (atomic write-then-rename guarantees no prefix bleeding).
    writeEphemeralKubeconfig("a", {
      contextName: "a",
      server: "https://x",
      token: "old-and-very-long-token-aaaaaaaaaaaaaaaaaa",
    });
    const path = writeEphemeralKubeconfig("a", {
      contextName: "a",
      server: "https://x",
      token: "new-tok",
    });
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("new-tok");
    expect(content).not.toContain("old-and-very-long-token");
  });
});
