/**
 * src/dashboard/commands.ts — copy-command generator per connection
 * subtype.
 *
 * Both surfaces render the same thing: the dashboard's "Copy command"
 * button and `hsh tunnel ls`. This module is the single source of truth
 * for those templates.
 *
 * Credentials come from the daemon
 *
 * The commands embed the fixed credentials the daemon reports per
 * connection. They are placeholders, not the database's real secrets: the
 * agent's protocol proxy accepts them locally and re-authenticates upstream
 * with the connection's stored credentials. Printing them is therefore safe,
 * and it is the point — the user should never have to hunt for real
 * credentials to use the tunnel.
 *
 * Earlier revisions guessed the database user from the shell-level current
 * user, which produced commands that could not connect.
 *
 * Why one module
 *
 *   - TypeScript exhaustive subtype checks, so adding a new subtype to
 *     ConnectionSubtype fails the build until a template is defined.
 *   - Trivial unit testing (no DOM, no fetch).
 *   - One place to update when rendering conventions change.
 */

import type { ConnectionSubtype } from "../tunnel/types";

/**
 * Inputs to renderCommand. `name` is the bare connection name (we append
 * `.hoop` ourselves); `username`/`password` are the daemon-reported fixed
 * credentials, empty for subtypes that authenticate out of band.
 */
export interface CommandTemplateInput {
  name: string;
  subtype: ConnectionSubtype;
  username: string;
  password: string;
  /** Canonical TCP port; 0 when the subtype accepts any port. */
  expectedPort?: number;
}

/**
 * Returns the copy-paste command line for the given connection.
 *
 * Always returns a non-empty string: unknown subtypes fall back to a generic
 * `nc` probe rather than throwing, because neither caller has a useful way to
 * recover from an exception mid-render.
 *
 * Host/port are omitted from most templates because the daemon already
 * enforces the canonical port for the subtype — an explicit port would only
 * add clutter, and a wrong one is rejected at the SYN.
 */
export function renderCommand(input: CommandTemplateInput): string {
  const host = `${input.name}.hoop`;
  // A daemon older than the credentials field omits it entirely, and
  // TunnelClient.connections() casts the raw JSON without validating, so
  // these can be undefined at runtime despite the types. Interpolating that
  // would print `-U undefined`, so fall back to the credential-free command
  // for the subtype instead.
  const user = input.username;
  const pass = input.password;
  const haveCreds = Boolean(user) && Boolean(pass);

  switch (input.subtype) {
    case "postgres":
      // psql has no password flag; PGPASSWORD is the only way to avoid an
      // interactive prompt. Without one, psql prompts — still usable.
      return haveCreds
        ? `PGPASSWORD=${pass} psql -h ${host} -U ${user}`
        : `psql -h ${host}`;

    case "mysql":
      // mysql takes the password glued to -p, with no space. A bare -p
      // prompts for it.
      return haveCreds
        ? `mysql -h ${host} -u ${user} -p${pass}`
        : `mysql -h ${host} -p`;

    case "mssql":
      // sqlcmd is Microsoft's CLI; works on Linux + macOS + Windows.
      return haveCreds
        ? `sqlcmd -S ${host} -U ${user} -P ${pass}`
        : `sqlcmd -S ${host}`;

    case "mongodb":
      // directConnection=true: the proxy fronts a single endpoint and does
      // not implement replica-set discovery, so a driver left to run its own
      // topology scan would try to dial the real cluster members by their
      // internal hostnames and fail.
      return haveCreds
        ? `mongosh "mongodb://${user}:${pass}@${host}/?directConnection=true"`
        : `mongosh "mongodb://${host}/?directConnection=true"`;

    case "oracledb":
      // sqlplus's connect-string syntax needs the port spelled out.
      return haveCreds
        ? `sqlplus ${user}/${pass}@${host}:${input.expectedPort ?? 1521}`
        : `sqlplus @${host}:${input.expectedPort ?? 1521}`;

    case "httpproxy":
      // Authorization rides headers the agent injects, and the tunnel has
      // no certificate for *.hoop, so the scheme is plain http on port 80.
      return `curl http://${host}/`;

    case "tcp":
      // An opaque user-defined upstream: Hoop cannot know which client the
      // user needs, and any credentials are their own.
      return `nc -v ${host} <port>`;

    default: {
      // Exhaustiveness check. If a new subtype is added to
      // ConnectionSubtype, TypeScript flags this branch because
      // `_exhaustive` is typed as `never`.
      const _exhaustive: never = input.subtype;
      void _exhaustive;
      return `nc -v ${host} <port>`;
    }
  }
}
