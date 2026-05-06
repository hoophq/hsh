/**
 * Exit codes used by the ssh and kubectl plugins.
 *
 * The contract for scripts that wrap hsh:
 *
 *   $?  | meaning
 *   ----|----------------------------------------------------------------
 *    0  | clean success (passthrough succeeded OR Hoop-routed child exited 0)
 *   1-127 reserved for the underlying ssh/kubectl child — passed through
 *         verbatim when hsh successfully launches the child.
 *   75  | EX_TEMPFAIL — Hoop says this connection requires approval and
 *         the credentials weren't issued yet. The user has been told to
 *         go approve it; their script should treat this as 'try again
 *         later', NOT as success.
 *   77  | EX_NOPERM — Hoop session has expired (refresh token also dead).
 *         The user has been told to run `hsh login`. Distinct from 75 so
 *         scripts can differentiate "approval-pending, retry" from
 *         "session-dead, needs interactive login".
 *   1   | generic hsh-internal error before the child could be spawned
 *         (e.g. malformed credentials response, unexpected throw). This
 *         collides with ssh's generic-1 but we have to ship something.
 *
 * EX_TEMPFAIL is from BSD sysexits.h, which uses 64–78 for command-line
 * tool conventions. We pick 75 specifically because it's the closest
 * match: 'temporary failure, indicating something that is not really an
 * error. In sendmail, this means that a mailer (e.g.) could not create a
 * connection, and the request should be reattempted later.'
 *
 * Source of truth — every `process.exit(...)` in ssh.ts / kubectl.ts must
 * use one of these constants. The audit lives in
 * tests/exit-codes.test.ts (static test that grep's the source).
 */

export const ExitCodes = {
  /**
   * Clean success. Used by `passthrough()` and the Hoop-routed flow when
   * the spawned child exits 0.
   */
  Success: 0,

  /**
   * Generic hsh-internal failure that happened BEFORE the child could be
   * spawned (e.g. unexpected throw, malformed credential response).
   * Collides with ssh's generic-1 but is the safest catch-all.
   */
  GenericError: 1,

  /**
   * EX_TEMPFAIL (sysexits.h §75). The Hoop connection requires approval
   * and credentials weren't issued; user has been told to go approve.
   * Distinct from `Success` so script callers can differentiate
   * 'connected and ran' from 'still waiting on review'.
   */
  ReviewPending: 75,

  /**
   * EX_NOPERM (sysexits.h §77). The Hoop session is dead (the gateway
   * tried to refresh transparently via the X-New-Access-Token header
   * and gave up — refresh token itself is expired/revoked). The user
   * has been told to run `hsh login`. We deliberately do NOT auto-launch
   * a browser mid-`ssh`/`kubectl` invocation: a sudden browser pop is
   * surprising and disruptive (ENG-359). Distinct from ReviewPending so
   * script wrappers can branch.
   */
  AuthRequired: 77,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
