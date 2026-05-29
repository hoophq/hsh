/**
 * src/dashboard/commands.ts — copy-command generator per connection
 * subtype.
 *
 * The dashboard renders one button per connection: "Copy command".
 * The clipboard content is a ready-to-paste shell line that opens
 * the connection through the tunnel — `psql -h foo.hoop`, etc. This
 * module is the single source of truth for those templates.
 *
 * Why server-side
 *
 * The templates contain "${USER}" / "$USER" placeholders for the
 * shell-level current user. The dashboard runs *for* the user who
 * launched `hsh dashboard`, so the server can ask the OS once at
 * startup, bake it into the template, and ship a fully resolved
 * string to the browser. Doing this in the browser would either need
 * a separate endpoint to expose USER or rely on JavaScript guessing
 * (impossible — the page is sandboxed).
 *
 * Why one module
 *
 * Keeping the templates in TS (not in app.js) gives us:
 *   - TypeScript exhaustive subtype checks so adding a new subtype
 *     to ConnectionSubtype fails the build until a template is
 *     defined.
 *   - Trivial unit testing (no DOM, no fetch).
 *   - One place to update when the rendering conventions change
 *     (e.g. we decide to wrap names in quotes).
 */

import type { ConnectionSubtype } from "../tunnel/types";

/**
 * Inputs to renderCommand. `name` is the bare connection name (we
 * append `.hoop` ourselves); `userName` is the shell-level current
 * user we should default to for tools that require a -u flag.
 */
export interface CommandTemplateInput {
  name: string;
  subtype: ConnectionSubtype;
  userName: string;
}

/**
 * Returns the copy-paste command line for the given connection.
 * Always returns a non-empty string — unknown subtypes fall back to
 * a generic `nc` (netcat) snippet rather than throwing, because the
 * dashboard would have no useful way to recover.
 */
export function renderCommand(input: CommandTemplateInput): string {
  const host = `${input.name}.hoop`;
  switch (input.subtype) {
    case "postgres":
      // -h <host>: route through resolved/native DNS. We deliberately
      // do NOT pass -p because the daemon already enforces the
      // canonical port; an explicit one would just clutter the
      // command. Same reasoning for the rest of the templates below.
      return `psql -h ${host} -U ${input.userName}`;

    case "mysql":
      // mysql's `-p` without a value prompts for the password (the
      // safe option). `-u` defaults to the current user.
      return `mysql -h ${host} -u ${input.userName} -p`;

    case "mssql":
      // sqlcmd is Microsoft's CLI; works on Linux + macOS + Windows.
      // `-G` enables Active Directory password auth where applicable;
      // we leave it off because the gateway already provided credentials.
      return `sqlcmd -S ${host} -U ${input.userName} -P '<password>'`;

    case "mongodb":
      // mongosh is the modern shell; the connection string form
      // works without a `--host`/`--port` split.
      return `mongosh "mongodb://${input.userName}@${host}"`;

    case "oracledb":
      // sqlplus's connect-string syntax. The `<password>` placeholder
      // makes the user pause before hitting Enter, which is the
      // right UX (Oracle passwords aren't usually prompted-for).
      return `sqlplus ${input.userName}/<password>@${host}`;

    case "tcp":
      // Raw TCP connections don't have a "canonical port" — the
      // template uses a placeholder so the user can fill in the
      // remote port they need.
      return `nc -v ${host} <port>`;

    default: {
      // Exhaustiveness check. If a new subtype is added to
      // ConnectionSubtype, TypeScript will flag this default branch
      // because `_exhaustive` is typed as `never`. The runtime
      // fallback is a generic TCP probe.
      const _exhaustive: never = input.subtype;
      void _exhaustive;
      return `nc -v ${host} <port>`;
    }
  }
}
