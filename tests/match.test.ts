import { describe, expect, test } from "bun:test";
import type { Connection } from "../src/api/types.ts";
import { formatAmbiguityWarning, matchConnection } from "../src/plugins/match.ts";

/**
 * Connection-name matching uses a strict layered strategy with NO substring
 * fallback. Every test below pins both the chosen connection and the level
 * that produced the match so accidental priority drift fails loudly.
 */

function conn(
  name: string,
  extra: Partial<Connection> = {},
): Connection {
  return { id: name, name, type: "ssh", ...extra };
}

describe("matchConnection (ssh)", () => {
  test("exact name match wins over schema-field and tag", () => {
    const conns: Connection[] = [
      conn("a", { access_schema: { ssh_host: "target" }, tags: { host: "target" } }),
      conn("target"),
    ];
    const r = matchConnection(conns, "target", "ssh");
    expect(r.match?.name).toBe("target");
    expect(r.level).toBe("exact");
    expect(r.ambiguous).toBe(false);
  });

  test("exact-short matches FQDN against bare-name connection", () => {
    const conns: Connection[] = [conn("host"), conn("other")];
    const r = matchConnection(conns, "host.internal.example.com", "ssh");
    expect(r.match?.name).toBe("host");
    expect(r.level).toBe("exact-short");
  });

  test("exact-short does NOT match unrelated connection with similar prefix", () => {
    // The dangerous-substring case from the issue: 'prod' must not match 'production-db'.
    const conns: Connection[] = [conn("production-db"), conn("staging-db")];
    const r = matchConnection(conns, "prod", "ssh");
    expect(r.match).toBeNull();
    expect(r.level).toBeNull();
  });

  test("schema-field fallback when no exact match", () => {
    const conns: Connection[] = [
      conn("a", { access_schema: { ssh_host: "10.0.0.1" } }),
      conn("b"),
    ];
    const r = matchConnection(conns, "10.0.0.1", "ssh");
    expect(r.match?.name).toBe("a");
    expect(r.level).toBe("schema-field");
  });

  test("tag fallback (hostname / host)", () => {
    const conns: Connection[] = [
      conn("a", { tags: { hostname: "myhost" } }),
      conn("b", { tags: { host: "otherhost" } }),
    ];
    expect(matchConnection(conns, "myhost", "ssh").match?.name).toBe("a");
    expect(matchConnection(conns, "myhost", "ssh").level).toBe("tag");
    expect(matchConnection(conns, "otherhost", "ssh").match?.name).toBe("b");
    expect(matchConnection(conns, "otherhost", "ssh").level).toBe("tag");
  });

  test("returns null when no level matches (no substring fallback)", () => {
    const conns: Connection[] = [conn("production-db"), conn("staging-api")];
    const r = matchConnection(conns, "prod", "ssh");
    expect(r.match).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.level).toBeNull();
    expect(r.ambiguous).toBe(false);
  });

  test("ambiguity at the schema-field level returns all candidates + first wins", () => {
    const conns: Connection[] = [
      conn("a", { access_schema: { ssh_host: "shared.host" } }),
      conn("b", { access_schema: { ssh_host: "shared.host" } }),
    ];
    const r = matchConnection(conns, "shared.host", "ssh");
    expect(r.match?.name).toBe("a");
    expect(r.candidates.map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.level).toBe("schema-field");
    expect(r.ambiguous).toBe(true);
  });

  test("exact never produces ambiguity (names are unique by API contract — but we still report it)", () => {
    // Hypothetical case: API ever returns dupes — we should still detect it.
    const conns: Connection[] = [conn("dup"), conn("dup")];
    const r = matchConnection(conns, "dup", "ssh");
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.length).toBe(2);
    expect(r.match?.name).toBe("dup");
  });

  test("most specific level always wins", () => {
    // 'a' matches at exact, 'b' at schema-field. Exact must win.
    const conns: Connection[] = [
      conn("a"),
      conn("b", { access_schema: { ssh_host: "a" } }),
    ];
    const r = matchConnection(conns, "a", "ssh");
    expect(r.match?.name).toBe("a");
    expect(r.level).toBe("exact");
    expect(r.ambiguous).toBe(false);
  });
});

describe("matchConnection (kubectl)", () => {
  test("exact name match", () => {
    const conns: Connection[] = [conn("prod-cluster"), conn("dev-cluster")];
    const r = matchConnection(conns, "prod-cluster", "kubectl");
    expect(r.match?.name).toBe("prod-cluster");
    expect(r.level).toBe("exact");
  });

  test("exact-short level is NOT applied for kubectl (k8s contexts are usually short already)", () => {
    const conns: Connection[] = [conn("prod"), conn("dev")];
    // The user's current-context happens to be a dotted name — we should NOT
    // strip it and accidentally match a generic 'prod'. Substring is gone.
    const r = matchConnection(conns, "prod.eks.us-east-1", "kubectl");
    expect(r.match).toBeNull();
  });

  test("schema-field via cluster_name", () => {
    const conns: Connection[] = [
      conn("conn-a", { access_schema: { cluster_name: "eks-prod" } }),
    ];
    const r = matchConnection(conns, "eks-prod", "kubectl");
    expect(r.match?.name).toBe("conn-a");
    expect(r.level).toBe("schema-field");
  });

  test("tag via context / cluster", () => {
    const conns: Connection[] = [
      conn("a", { tags: { context: "ctx-1" } }),
      conn("b", { tags: { cluster: "clu-2" } }),
    ];
    expect(matchConnection(conns, "ctx-1", "kubectl").match?.name).toBe("a");
    expect(matchConnection(conns, "clu-2", "kubectl").match?.name).toBe("b");
  });

  test("returns null without substring fallback (regression guard)", () => {
    const conns: Connection[] = [conn("production-cluster")];
    const r = matchConnection(conns, "production", "kubectl");
    expect(r.match).toBeNull();
  });
});

describe("formatAmbiguityWarning", () => {
  test("lists candidates and the chosen name", () => {
    const conns: Connection[] = [
      conn("a", { tags: { host: "shared" } }),
      conn("b", { tags: { host: "shared" } }),
      conn("c", { tags: { host: "shared" } }),
    ];
    const r = matchConnection(conns, "shared", "ssh");
    const msg = formatAmbiguityWarning("shared", r);
    expect(msg).toContain("'shared'");
    expect(msg).toContain("level 'tag'");
    expect(msg).toContain("a, b, c");
    expect(msg).toContain("Using 'a'");
  });
});
