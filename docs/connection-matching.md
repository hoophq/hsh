# Connection matching

When you run `ssh <target>` or `kubectl --context <target> ...`, hsh has to decide whether `<target>` corresponds to a Hoop connection it should route through the gateway, or whether to fall through to native ssh/kubectl.

This document describes exactly how that decision is made. The implementation lives in [`src/plugins/match.ts`](../src/plugins/match.ts) and is shared by both plugins. There is no per-plugin override.

## Priority order

hsh evaluates four levels in order. The **first level that produces any match wins** — hsh stops looking at lower levels even if those would also match. If no level matches, hsh falls through to native passthrough.

| Order | Level           | ssh                                  | kubectl                              |
|-------|-----------------|--------------------------------------|--------------------------------------|
| 1     | `exact`         | `connection.name === target`         | `connection.name === target`         |
| 2     | `exact-short`*  | `connection.name === target.split(".")[0]` | _(not applied)_                |
| 3     | `schema-field`  | `connection.access_schema.ssh_host === target` | `connection.access_schema.cluster_name === target` |
| 4     | `tag`           | `connection.tags.hostname === target` or `connection.tags.host === target` | `connection.tags.context === target` or `connection.tags.cluster === target` |

\* The `exact-short` level only applies to ssh, because users routinely run `ssh host.internal.example.com` while the Hoop connection is named `host`. The single-label compare against the bare-name connection is safe because it only fires when no `exact` match exists. kubectl context names are typically short already, so the equivalent rule is not applied (and nothing strips dotted suffixes there).

## What is **not** done

There is **no substring fallback**. The previous implementation had:

```ts
const partial = connections.find(
  (c) => c.name.includes(target) || target.includes(c.name)
);
```

That made `ssh prod` accidentally route through the connection `production-db`. As of [ENG-351](https://linear.app/hoophq/issue/ENG-351) this fallback is gone. If you need to match a connection by anything other than exact name / schema field / tag, add an explicit `tags.host` (ssh) or `tags.context` (kubectl) entry on the connection.

## Ambiguity

If more than one Hoop connection matches at the **winning** level, hsh:

1. Picks the first candidate (stable order — whatever the API returned).
2. Prints a one-line warning to stderr listing every candidate by name and showing which one was used:

   ```
   Multiple Hoop connections match 'shared.host' at level 'tag': a, b, c. Using 'a'.
   ```

3. Continues with the picked connection.

This is *not* an error — failing the command would be a worse experience than picking deterministically. If you want strict matching, give each connection a unique tag.

## Worked examples

| Connections                                           | Target                          | Result                                                                 |
|-------------------------------------------------------|---------------------------------|------------------------------------------------------------------------|
| `[host]`                                              | `host`                          | match `host` (`exact`)                                                 |
| `[host]`                                              | `host.internal.example.com`     | match `host` (`exact-short`, ssh only)                                 |
| `[host, host-staging]`                                | `host`                          | match `host` (`exact`); `host-staging` is ignored                      |
| `[production-db]`                                     | `prod`                          | **no match** → native ssh                                              |
| `[a]` with `access_schema.ssh_host = "10.0.0.1"`      | `10.0.0.1`                      | match `a` (`schema-field`)                                             |
| `[a, b]` both with `tags.host = "shared"`             | `shared`                        | match `a` (`tag`, ambiguous → warning lists both)                      |
| `[prod-cluster]` (kubectl)                            | `prod-cluster`                  | match `prod-cluster` (`exact`)                                         |
| `[prod]` (kubectl)                                    | `prod.eks.us-east-1`            | **no match** → native kubectl (no `exact-short` for kubectl)           |

## Debugging

Set `HSH_DEBUG=1` (when [ENG-352](https://linear.app/hoophq/issue/ENG-352) lands) to see the level and candidate set chosen for every command. Until then, you can verify the rules by inspecting `tests/match.test.ts` — every priority level + ambiguity case is pinned by a golden test.
