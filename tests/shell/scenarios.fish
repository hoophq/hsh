#!/usr/bin/env fish
# Fish-shell scenario harness for `hsh shell-init --shell fish`.
# Mirrors tests/shell/scenarios.sh for the fish-specific generator.
#
# Inputs (env): TMP_DIR, REAL_BIN_DIR, SCENARIO

set -gx LOG "$TMP_DIR/fake-hsh.log"

# Install the fake hsh shim. Same setup as scenarios.sh — records argv
# to $LOG, exits with $FAKE_HSH_EXIT (default 0).
mkdir -p "$TMP_DIR/bin"
echo '#!/bin/sh
echo "argv: $*" >> "$LOG"
exit "${FAKE_HSH_EXIT:-0}"' > "$TMP_DIR/bin/hsh"
chmod +x "$TMP_DIR/bin/hsh"

# CRITICAL: render the script using the REAL binary, then SWAP PATH to
# only contain the fake bin dir before sourcing. If $REAL_BIN_DIR remains
# on PATH the `command hsh` inside the function would resolve to the
# real binary at runtime.
set -l init_script ("$REAL_BIN_DIR/hsh" shell-init --shell fish | string collect)
set -gx PATH "$TMP_DIR/bin" /usr/bin /bin
echo "$init_script" | source

switch "$SCENARIO"
  case defines_ssh_function
    if functions -q ssh
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: ssh is not a fish function"
      exit 1
    end

  case defines_kubectl_function
    if functions -q kubectl
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: kubectl is not a fish function"
      exit 1
    end

  case function_routes_through_hsh
    : > $LOG
    ssh user@example.com -p 2222
    if grep -q "argv: plugin run ssh -- user@example.com -p 2222" $LOG
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: function did not route through hsh; log: $(cat $LOG)"
      exit 1
    end

  case command_bypass_skips_hsh
    : > $LOG
    command ssh nonexistent-host 2>/dev/null
    set rc $status
    if test $rc -ne 0
      if not test -s $LOG
        echo "RESULT: ok"
      else
        echo "RESULT: FAIL: command bypass leaked into hsh; log: $(cat $LOG)"
        exit 1
      end
    else
      echo "RESULT: FAIL: command ssh returned 0 unexpectedly"
      exit 1
    end

  case exit_code_propagates
    : > $LOG
    set -lx FAKE_HSH_EXIT 42
    ssh anyhost
    set rc $status
    if test $rc -eq 42
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: expected exit 42, got $rc"
      exit 1
    end

  case git_ssh_command_export
    if test "$GIT_SSH_COMMAND" = "hsh plugin run ssh --"
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: GIT_SSH_COMMAND not exported: '$GIT_SSH_COMMAND'"
      exit 1
    end

  case rsync_rsh_export
    if test "$RSYNC_RSH" = "hsh plugin run ssh --"
      echo "RESULT: ok"
    else
      echo "RESULT: FAIL: RSYNC_RSH not exported: '$RSYNC_RSH'"
      exit 1
    end

  case '*'
    echo "RESULT: FAIL: unknown scenario '$SCENARIO'"
    exit 1
end
