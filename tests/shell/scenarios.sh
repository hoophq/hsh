#!/bin/sh
# POSIX-shell scenario harness for `hsh shell-init`.
#
# Sourced by the test runner in tests/shell-integration.test.ts via
# bash, zsh, and `sh` (dash on Linux, bash-as-sh on macOS) to exercise:
#
#   - shell function defined for ssh/kubectl
#   - 'command ssh' bypasses the function
#   - subshells inherit the function and the env vars
#   - exit codes propagate (set -e, $?)
#   - piped output works (no buffering surprises)
#
# We don't actually call the real ssh/kubectl — that would require real
# credentials. Instead we install a fake `hsh` shim on PATH that records
# its argv to a side file. This proves the SHELL function correctly
# routes invocations; the binary's behavior is covered by other tests.
#
# Inputs:
#   $TMP_DIR        — writable scratch dir (cleaned up by the runner)
#   $SCENARIO       — which scenario to run; see the case statement below
#
# Output: one line of `RESULT: <ok|FAIL: …>` to stdout.
# Exit:   0 on success, 1 on failure.

set -u  # error on undefined variable; intentionally NOT set -e (we want
        # to assert non-zero exits without aborting the whole script)

LOG="$TMP_DIR/fake-hsh.log"
export LOG

# Install the fake hsh shim. Records argv to $LOG, then exits with whatever
# code is in $FAKE_HSH_EXIT (default 0). The shell function calls
# `command hsh plugin run ssh -- ...`; we want THAT lookup to hit our fake,
# not the real binary at $REAL_BIN_DIR.
mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/hsh" <<'SHIM'
#!/bin/sh
echo "argv: $*" >> "$LOG"
exit "${FAKE_HSH_EXIT:-0}"
SHIM
chmod +x "$TMP_DIR/bin/hsh"

# CRITICAL: render shell-init using the REAL binary, then SWAP PATH so
# only the fake bin dir is searched at runtime. If we keep $REAL_BIN_DIR
# on PATH afterwards, `command hsh` inside the function would hit the
# real binary first (which would try to actually issue credentials and
# spawn real ssh).
INIT_SCRIPT="$("$REAL_BIN_DIR/hsh" shell-init)"
PATH="$TMP_DIR/bin:/usr/bin:/bin"
export PATH
eval "$INIT_SCRIPT"

case "$SCENARIO" in
  defines_ssh_function)
    # Behavioral check: invoke `ssh` and verify it routed through our
    # fake hsh shim (writes to $LOG). If ssh were the system binary or
    # the function weren't defined, $LOG would stay empty.
    : > "$LOG"
    ssh defines-ssh-test-host > /dev/null 2>&1
    if grep -q "argv: plugin run ssh -- defines-ssh-test-host" "$LOG"; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: ssh did not route through hsh; log: $(cat "$LOG")"
      exit 1
    fi
    ;;

  defines_kubectl_function)
    : > "$LOG"
    kubectl defines-kubectl-test > /dev/null 2>&1
    if grep -q "argv: plugin run kubectl -- defines-kubectl-test" "$LOG"; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: kubectl did not route through hsh; log: $(cat "$LOG")"
      exit 1
    fi
    ;;

  function_routes_through_hsh)
    : > "$LOG"
    ssh user@example.com -p 2222
    if grep -q "argv: plugin run ssh -- user@example.com -p 2222" "$LOG"; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: function did not route through hsh; log: $(cat "$LOG")"
      exit 1
    fi
    ;;

  command_bypass_skips_hsh)
    # `command ssh` should NOT enter the shell function (which uses
    # `command hsh ...` internally). The behavior depends on the shell:
    # - bash/zsh: 'command ssh' looks up ssh on PATH (the system ssh).
    # - sh/dash: same.
    # We don't have a system ssh in our PATH-stripped test env, so we
    # expect the lookup to fail — which proves the bypass works.
    : > "$LOG"
    set +e
    command ssh nonexistent-host 2>/dev/null
    rc=$?
    set -e
    # The function would have routed to our fake hsh (exit 0). A non-zero
    # exit here means we successfully bypassed and tried to run the real
    # ssh (which doesn't exist on PATH for this test).
    if [ "$rc" -ne 0 ] && [ ! -s "$LOG" ]; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: 'command ssh' was intercepted (rc=$rc, log=$(cat "$LOG"))"
      exit 1
    fi
    ;;

  exit_code_propagates)
    : > "$LOG"
    FAKE_HSH_EXIT=42 ssh anyhost
    rc=$?
    if [ "$rc" -eq 42 ]; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: expected exit 42, got $rc"
      exit 1
    fi
    ;;

  exit_code_in_conditionals)
    # Scripts using && / || / if / [ test the function's exit code via $?.
    # That's the contract that actually matters for wrapped scripts —
    # `set -e` has POSIX-defined exemptions that vary across shells, and
    # is intentionally NOT what we lock down here.
    : > "$LOG"

    # Failure case: function returns 7, || branch should fire.
    branch=miss
    FAKE_HSH_EXIT=7 ssh anyhost > /dev/null 2>&1 || branch=or
    if [ "$branch" != "or" ]; then
      echo "RESULT: FAIL: || branch did not fire on non-zero exit"
      exit 1
    fi

    # Success case: function returns 0, && branch should fire.
    branch=miss
    FAKE_HSH_EXIT=0 ssh anyhost > /dev/null 2>&1 && branch=and
    if [ "$branch" != "and" ]; then
      echo "RESULT: FAIL: && branch did not fire on zero exit"
      exit 1
    fi

    # `if` form: explicit $?.
    if FAKE_HSH_EXIT=3 ssh anyhost > /dev/null 2>&1; then
      echo "RESULT: FAIL: if-true taken on non-zero exit"
      exit 1
    fi

    echo "RESULT: ok"
    ;;

  subshell_inherits_function)
    # Functions ARE inherited into ( … ) subshells in POSIX shells. Verify.
    : > "$LOG"
    ( ssh subhost )
    if grep -q "argv: plugin run ssh -- subhost" "$LOG"; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: subshell did not see the function; log: $(cat "$LOG")"
      exit 1
    fi
    ;;

  pipe_works)
    : > "$LOG"
    # Output going to a pipe must not be buffered such that we lose stderr
    # ordering. The fake hsh writes nothing to stdout so this is mostly
    # checking that the function doesn't barf when piped.
    ssh phost | cat > /dev/null
    if grep -q "argv: plugin run ssh -- phost" "$LOG"; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: pipe broke the function; log: $(cat "$LOG")"
      exit 1
    fi
    ;;

  git_ssh_command_export)
    # GIT_SSH_COMMAND should be set in the current shell after sourcing.
    if [ "${GIT_SSH_COMMAND:-}" = "hsh plugin run ssh --" ]; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: GIT_SSH_COMMAND not exported correctly: '${GIT_SSH_COMMAND:-<unset>}'"
      exit 1
    fi
    ;;

  rsync_rsh_export)
    if [ "${RSYNC_RSH:-}" = "hsh plugin run ssh --" ]; then
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: RSYNC_RSH not exported correctly: '${RSYNC_RSH:-<unset>}'"
      exit 1
    fi
    ;;

  *)
    echo "RESULT: FAIL: unknown scenario '$SCENARIO'"
    exit 1
    ;;
esac
