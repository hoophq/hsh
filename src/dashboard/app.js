// hsh dashboard — vanilla ES module, no framework.
//
// Wire shape: every dynamic call goes to /api/* on the same origin.
// The server proxies those to the daemon's Unix-socket IPC and adds
// CSRF + auth. The page is bootstrapped with the CSRF token baked
// into a <meta> tag by the server at first request.

// ----- bootstrap -----

const csrfToken = (() => {
  // The server emits <meta name="csrf-token" content="..."> when it
  // renders index.html. If that meta is missing we still try to run
  // but mutating endpoints will 403.
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.getAttribute("content") || "" : "";
})();

const $ = (sel) => document.querySelector(sel);

const els = {
  pill: $("#status-pill"),
  pillLabel: $("#status-pill .label"),
  panelStatus: $("#panel-status"),
  panelConnections: $("#panel-connections"),
  panelEmpty: $("#panel-empty"),
  panelUnreachable: $("#panel-unreachable"),
  kvDaemon: $("#kv-daemon"),
  kvDaemonVersion: $("#kv-daemon-version"),
  kvAuth: $("#kv-auth"),
  kvSince: $("#kv-since"),
  kvLastError: $("#kv-last-error"),
  btnSignin: $("#btn-signin"),
  btnSignout: $("#btn-signout"),
  btnRetry: $("#btn-retry"),
  signinMsg: $("#signin-message"),
  connectionsList: $("#connections-list"),
};

// ----- HTTP helpers -----

/**
 * Issue an API request against our local server. GET/HEAD don't carry
 * a CSRF token; mutating verbs do, via X-CSRF-Token.
 *
 * Returns the parsed JSON body for 2xx (or null for 204), throws an
 * Error with .status and .body for non-2xx. The throw shape is
 * deliberately small — the few callers handle it inline.
 */
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (method !== "GET" && method !== "HEAD" && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const resp = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    // Keep this same-origin; the server lives on 127.0.0.1.
    credentials: "same-origin",
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; leave parsed null and use text below
  }
  if (!resp.ok) {
    const err = new Error(
      (parsed && parsed.message) ||
        text ||
        `request failed: HTTP ${resp.status}`,
    );
    err.status = resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// ----- panel visibility helpers -----

function setPanel(el, visible) {
  if (visible) {
    el.removeAttribute("hidden");
  } else {
    el.setAttribute("hidden", "");
  }
}

function setPill(state, label) {
  // state ∈ { ok, warn, err, unknown }
  for (const cls of ["pill-ok", "pill-warn", "pill-err", "pill-unknown"]) {
    els.pill.classList.remove(cls);
  }
  els.pill.classList.add(`pill-${state}`);
  els.pillLabel.textContent = label;
}

// ----- main render loop -----

/**
 * Pull /api/status + /api/connections (the latter only if logged in)
 * and update the UI. Called on first load, after sign-in / sign-out,
 * and on a slow poll while the page is visible.
 *
 * Side effects: mutates the DOM. Never throws — transport failures
 * end up in the unreachable panel.
 */
async function refresh() {
  let status;
  try {
    status = await api("GET", "/api/status");
  } catch (err) {
    showUnreachable(err);
    return;
  }

  // We got a response — daemon is alive. Decide which panels to show
  // based on logged-in state.
  setPanel(els.panelUnreachable, false);
  setPanel(els.panelStatus, true);

  // Status panel KVs.
  els.kvDaemon.textContent = status.running ? "running" : "idle";
  els.kvDaemonVersion.textContent = status.daemon_version || "—";
  els.kvAuth.textContent = status.logged_in ? "yes" : "no";
  els.kvSince.textContent = status.since ? formatSince(status.since) : "—";
  els.kvLastError.textContent = status.last_error || "—";

  if (status.logged_in && status.running) {
    setPill("ok", "tunnel up");
    setPanel(els.btnSignin, false);
    setPanel(els.btnSignout, true);
    await renderConnections();
  } else if (status.logged_in && !status.running) {
    // Logged in but the tunnel didn't come up — surface the error.
    setPill("err", "bring-up failed");
    setPanel(els.btnSignin, false);
    setPanel(els.btnSignout, true);
    setPanel(els.panelConnections, false);
    setPanel(els.panelEmpty, false);
  } else {
    // Daemon up but not authenticated yet.
    setPill("warn", "sign-in required");
    setPanel(els.btnSignin, true);
    setPanel(els.btnSignout, false);
    setPanel(els.panelConnections, false);
    setPanel(els.panelEmpty, false);
  }
}

async function renderConnections() {
  let conns;
  try {
    conns = await api("GET", "/api/connections");
  } catch (err) {
    // Logged in but connections endpoint failed — keep the rest of
    // the UI intact, just hide the list.
    setPanel(els.panelConnections, false);
    setPanel(els.panelEmpty, false);
    return;
  }
  if (!conns || conns.length === 0) {
    setPanel(els.panelConnections, false);
    setPanel(els.panelEmpty, true);
    return;
  }
  setPanel(els.panelEmpty, false);
  setPanel(els.panelConnections, true);
  els.connectionsList.innerHTML = "";
  for (const c of conns) {
    els.connectionsList.appendChild(connectionRow(c));
  }
}

function connectionRow(c) {
  const li = document.createElement("li");
  li.className = "conn-item";

  const left = document.createElement("div");
  left.className = "left";

  const host = document.createElement("div");
  host.className = "host";
  host.textContent = `${c.name}.hoop`;

  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = c.subtype;
  meta.appendChild(badge);
  if (c.expected_port) {
    const port = document.createElement("span");
    port.textContent = `port ${c.expected_port}`;
    meta.appendChild(port);
  }
  const ip = document.createElement("span");
  ip.textContent = c.virtual_ip;
  meta.appendChild(ip);

  left.appendChild(host);
  left.appendChild(meta);

  const right = document.createElement("div");
  right.className = "right";
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "Copy command";
  copyBtn.addEventListener("click", () => copyCommand(c, copyBtn));
  right.appendChild(copyBtn);

  li.appendChild(left);
  li.appendChild(right);
  return li;
}

/**
 * Ask the server for a ready-to-paste command for this subtype, copy
 * it to the clipboard, and animate the button to confirm. Server-side
 * generation keeps the per-subtype templates in one place (TypeScript
 * unit-testable) instead of in the page.
 */
async function copyCommand(conn, btn) {
  let cmd;
  try {
    const resp = await api("GET", `/api/commands/${encodeURIComponent(conn.subtype)}?name=${encodeURIComponent(conn.name)}`);
    cmd = resp.command;
  } catch {
    btn.textContent = "error";
    setTimeout(() => (btn.textContent = "Copy command"), 1500);
    return;
  }
  try {
    await navigator.clipboard.writeText(cmd);
    btn.classList.add("copied");
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.textContent = "Copy command";
    }, 1500);
  } catch {
    // Permissions denied — fall back to a visible prompt so the user
    // can copy manually. Better than silent failure.
    window.prompt(`Copy this command:`, cmd);
  }
}

// ----- sign-in / sign-out -----

async function signIn() {
  els.btnSignin.disabled = true;
  showSigninMessage("Opening your browser…");
  let start;
  try {
    start = await api("POST", "/api/login/start");
  } catch (err) {
    showSigninMessage(`Sign-in failed: ${err.message}`, true);
    els.btnSignin.disabled = false;
    return;
  }
  // The daemon returns the browser URL it wants opened. We open it
  // in the same tab? No — that would lose this page. New window.
  window.open(start.browser_url, "_blank", "noopener,noreferrer");
  showSigninMessage("Waiting for the browser callback…");

  // Poll /api/login/poll until done/error or timeout.
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    let r;
    try {
      r = await api("GET", `/api/login/poll?state=${encodeURIComponent(start.state)}`);
    } catch (err) {
      showSigninMessage(`Sign-in failed: ${err.message}`, true);
      els.btnSignin.disabled = false;
      return;
    }
    if (r.status === "done") {
      showSigninMessage("");
      els.btnSignin.disabled = false;
      await refresh();
      return;
    }
    if (r.status === "error") {
      showSigninMessage(`Sign-in failed: ${r.error || "unknown error"}`, true);
      els.btnSignin.disabled = false;
      return;
    }
  }
  showSigninMessage("Sign-in timed out.", true);
  els.btnSignin.disabled = false;
}

async function signOut() {
  els.btnSignout.disabled = true;
  try {
    await api("POST", "/api/logout");
  } catch (err) {
    // The daemon idempotently treats "no token" as 204, so a real
    // error here is unusual. Show it.
    showSigninMessage(`Sign-out failed: ${err.message}`, true);
    els.btnSignout.disabled = false;
    return;
  }
  els.btnSignout.disabled = false;
  await refresh();
}

function showSigninMessage(text, isError = false) {
  if (!text) {
    setPanel(els.signinMsg, false);
    return;
  }
  els.signinMsg.textContent = text;
  els.signinMsg.classList.toggle("error", isError);
  setPanel(els.signinMsg, true);
}

// ----- unreachable handling -----

function showUnreachable(err) {
  setPill("err", "daemon down");
  setPanel(els.panelStatus, false);
  setPanel(els.panelConnections, false);
  setPanel(els.panelEmpty, false);
  setPanel(els.panelUnreachable, true);
  // Log to console for power users; the panel itself stays brief.
  console.warn("dashboard: daemon unreachable:", err);
}

// ----- formatting helpers -----

function formatSince(iso) {
  // Zero-time guard (matches the same guard the CLI has).
  if (iso === "0001-01-01T00:00:00Z") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----- wire up + first paint -----

els.btnSignin.addEventListener("click", signIn);
els.btnSignout.addEventListener("click", signOut);
els.btnRetry.addEventListener("click", refresh);

// First render.
refresh();

// Slow poll while the tab is visible. We pick 5s as a balance:
// quick enough to feel responsive when the daemon state changes
// underneath us (a separate `hsh tunnel logout` from the terminal),
// slow enough to not hammer the IPC socket. Pauses on visibility
// change to be a good citizen on laptops.
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.visibilityState === "visible") {
    pollTimer = setTimeout(async () => {
      await refresh();
      schedulePoll();
    }, 5000);
  }
}
document.addEventListener("visibilitychange", schedulePoll);
schedulePoll();
