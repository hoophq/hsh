import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  buildKubeconfigEnv,
  writeEphemeralKubeconfig,
} from "../src/plugins/kubeconfig.ts";

/**
 * Integration tests that shell out to a real `kubectl config view` to verify
 * that the YAML we emit is parseable by kubectl and merges with the user's
 * existing config without mutating it.
 *
 * Skipped when kubectl is not on PATH (e.g. CI without kubectl installed).
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
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-kube-int-"));
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

describeIfKubectl("kubectl integration: rendered YAML is parseable", () => {
  test("kubectl config view accepts the generated kubeconfig", () => {
    const path = writeEphemeralKubeconfig("prod-cluster", {
      contextName: "prod-cluster",
      server: "https://gw.example.com:8443",
      token: "abc.def.ghi",
    });

    const r = spawnSync(
      "kubectl",
      ["config", "view", `--kubeconfig=${path}`, "-o=jsonpath={.current-context}"],
      { encoding: "utf-8" }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("prod-cluster");
  });

  test("kubectl reports the Hoop server URL for the rendered context", () => {
    const path = writeEphemeralKubeconfig("c1", {
      contextName: "c1",
      server: "https://gw.example.com:8443",
      token: "tok",
    });

    const r = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        `--kubeconfig=${path}`,
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8" }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("https://gw.example.com:8443");
  });

  test("KUBECONFIG merge: hsh entry shadows user's matching context, leaves user config bytes intact", () => {
    // Write a user kubeconfig that contains a `prod-cluster` context pointing
    // at a different server. Capture its byte content. Run kubectl with the
    // merged KUBECONFIG and assert the Hoop server wins. Then re-read the
    // user's file and assert it is byte-identical.
    const userKubeconfig = join(tmpHshHome, "user-kube-config");
    const userYaml =
      "apiVersion: v1\n" +
      "kind: Config\n" +
      'current-context: "prod-cluster"\n' +
      "clusters:\n" +
      '- name: "real-prod"\n' +
      "  cluster:\n" +
      '    server: "https://real.example.com:6443"\n' +
      "users:\n" +
      '- name: "real-user"\n' +
      "  user:\n" +
      '    token: "user-tok"\n' +
      "contexts:\n" +
      '- name: "prod-cluster"\n' +
      "  context:\n" +
      '    cluster: "real-prod"\n' +
      '    user: "real-user"\n';
    writeFileSync(userKubeconfig, userYaml, { mode: 0o600 });
    const userBefore = readFileSync(userKubeconfig);

    const hshPath = writeEphemeralKubeconfig("prod-cluster", {
      contextName: "prod-cluster",
      server: "https://gw.example.com:8443",
      token: "hsh-tok",
    });

    const merged = buildKubeconfigEnv(hshPath, userKubeconfig);

    // current-context.cluster.server resolved through the merged config
    const r = spawnSync(
      "kubectl",
      [
        "config",
        "view",
        "--minify", // only the current context
        "-o=jsonpath={.clusters[0].cluster.server}",
      ],
      { encoding: "utf-8", env: { ...process.env, KUBECONFIG: merged } }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("https://gw.example.com:8443");

    // The user's kubeconfig file is bit-for-bit unchanged.
    const userAfter = readFileSync(userKubeconfig);
    expect(userAfter.equals(userBefore)).toBe(true);
    expect(existsSync(userKubeconfig)).toBe(true);
  });
});
