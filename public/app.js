/* Care Loop web app.
 * Accounts, care profiles and uploads are stored on the server (see /api). Role permissions
 * from the PRD are checked here for a friendly message and enforced again by the server.
 */
(() => {
  "use strict";

  const JOIN_KEY = "careloop-pending-join";
  const MIN_PASSWORD = 10;
  const INVITE_DAYS = 7;
  const MAX_UPLOAD = 20 * 1024 * 1024;
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const ROLE_LABEL = { family: "Family caregiver", assisting: "Assisting caregiver", physician: "Physician" };
  const DOC_LABEL = { chart: "Medical chart", prescription: "Written prescription", other: "Other" };
  const TABS = [
    ["schedule", "Schedule"],
    ["medical", "Medical History"],
    ["notes", "Doctor's notes"],
    ["logs", "Logs"],
    ["team", "Care team & history"],
    ["ai", "AI assistant"],
  ];
  const PERMS = {
    family: ["editProfile", "manageTeam", "editSchedule", "followups", "medical", "notes", "logs", "deleteProfile"],
    assisting: ["followups", "logs"],
    physician: ["followups", "medical", "notes", "logs"],
  };

  const view = document.getElementById("view");
  const trialBanner = document.getElementById("trial-banner");
  const who = document.getElementById("who");
  const ui = { profileId: null, tab: "schedule" };
  const db = { profiles: [] };
  let profilesLoaded = false;
  let pendingInvites = 0;
  const savingIds = new Set();

  // ---------- helpers ----------
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Text people typed (names, medications, notes): shown as written, never machine-translated.
  const u = (s) => `<span translate="no">${h(s)}</span>`;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const localISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString(); };
  const todayISO = () => localISO().slice(0, 10);
  const nowTime = () => localISO().slice(11, 16);
  const LOCALE = window.CareLoopI18n?.locale;
  const fmtDate = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
  const fmtStamp = (iso) => new Date(iso).toLocaleString(LOCALE, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtTime = (t) => { if (!t) return ""; const [hh, mm] = t.split(":").map(Number); return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" }); };
  const fmtPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`; return p || ""; };
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB";

  function toast(msg, isErr) {
    const region = document.getElementById("toast-region");
    region.innerHTML = `<div class="toast${isErr ? " err" : ""}" role="${isErr ? "alert" : "status"}">${h(msg)}</div>`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { region.innerHTML = ""; }, isErr ? 6000 : 2200);
  }

  const me = () => account && account.user;
  const stamp = () => ({ byName: me().name, byEmail: me().email, byRole: myRole(currentProfile()) || "family", at: new Date().toISOString() });
  const currentProfile = () => db.profiles.find((p) => p.id === ui.profileId) || null;

  function membership(p, email = me()?.email) {
    return p.team.find((m) => m.email && m.email === email && (m.status === "owner" || m.status === "joined"));
  }
  function myRole(p) { const m = p && membership(p); return m ? m.role : null; }
  function can(p, action) { const r = myRole(p); return !!r && PERMS[r].includes(action); }
  const visibleProfiles = () => db.profiles.filter((p) => membership(p));

  // Every change goes through here: offline and role checks, a history entry, then a save
  // to the server. The change shows straight away; if the server refuses it, it's undone.
  function commit(p, action, historyText, mutate) {
    if (!navigator.onLine) { toast("Not saved: you're offline.", true); return false; }
    if (!can(p, action)) { toast("Not saved: your role can't make this change.", true); return false; }
    if (savingIds.has(p.id)) { toast("Still saving your last change. Try again in a moment.", true); return false; }
    const before = clone(p);
    mutate();
    p.history.unshift({ id: uid(), text: historyText, ...stamp() });
    save(p, before);
    return true;
  }

  async function save(p, before) {
    savingIds.add(p.id);
    toast("Saving…");
    try {
      const { profile } = await api(`/api/profiles?id=${encodeURIComponent(p.id)}`, { method: "PUT", body: { profile: p, version: p.version } });
      replaceProfile(p, profile);
      toast("Saved");
      if (!document.activeElement?.closest("form")) render();
    } catch (err) {
      replaceProfile(p, err.data?.profile || before);
      toast("Not saved: " + err.message, true);
      render();
    } finally {
      savingIds.delete(p.id);
    }
  }

  // Swap in the server's copy, keeping the same object so open views stay attached.
  function replaceProfile(p, fresh) {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, fresh);
  }

  async function loadProfiles() {
    try {
      const data = await api("/api/profiles");
      db.profiles = data.profiles;
      pendingInvites = data.pendingInvites || 0;
      profilesLoaded = true;
    } catch (err) {
      toast("Couldn't load your profiles: " + err.message, true);
    }
  }

  // ---------- account, free trial and subscription ----------
  // The 7-day trial starts when the account is created; after that the server only grants
  // access with an active Whop subscription, or to people invited onto someone's care team.
  let account = null;   // response from /api/auth?action=me, or null when signed out
  let loading = true;
  const params = new URLSearchParams(location.search);
  const justSubscribed = params.has("subscribed");
  if (params.has("login")) ui.authMode = "login";
  if (params.has("reset")) { ui.authMode = "reset"; ui.reset = { token: params.get("reset"), email: params.get("email") || "" }; }
  if (params.has("join") && params.has("profile")) {
    try { sessionStorage.setItem(JOIN_KEY, JSON.stringify({ token: params.get("join"), profileId: params.get("profile") })); } catch { /* ignore */ }
  }
  const pendingJoin = () => { try { return JSON.parse(sessionStorage.getItem(JOIN_KEY)); } catch { return null; } };
  if (pendingJoin() && !ui.authMode) ui.authMode = "signup";
  const verifiedParam = params.get("verified");
  if ([...params.keys()].some((k) => ["reset", "email", "join", "profile", "verified", "login"].includes(k))) {
    history.replaceState(null, "", location.pathname + (justSubscribed ? "?subscribed=1" : ""));
  }

  async function api(path, options = {}) {
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { status: r.status, data });
    return data;
  }

  // Ask the server who is signed in and whether they can use the app.
  async function loadAccount(refresh) {
    try {
      account = await api("/api/auth?action=me" + (refresh ? "&refresh=1" : ""));
      await afterSignIn();
    } catch (err) {
      if (err.status === 401) account = null;
      else if (!account) toast(err.message, true);
    }
    loading = false;
    render();
  }

  // Once signed in with access: load profiles and finish joining from a doctor link.
  async function afterSignIn() {
    if (!account?.access) return;
    await loadProfiles();
    const join = pendingJoin();
    if (!join) return;
    try {
      const { profile } = await api("/api/profiles?action=join", { method: "POST", body: join });
      sessionStorage.removeItem(JOIN_KEY);
      const i = db.profiles.findIndex((x) => x.id === profile.id);
      if (i >= 0) db.profiles[i] = profile; else db.profiles.push(profile);
      ui.profileId = profile.id;
      ui.tab = "medical";
      toast(`You've joined ${profile.name}'s care team.`);
    } catch (err) {
      if (!err.data?.needsVerification) sessionStorage.removeItem(JOIN_KEY);
      toast(err.message, true);
    }
  }

  function renderTrialBanner() {
    let html;
    if (!account) html = "<strong>7-day free trial.</strong> No credit card needed.";
    else if (account.subscribed) html = "<strong>You're subscribed to Care Loop.</strong> Thank you!";
    else if (account.trial.active) {
      const left = account.trial.daysLeft;
      html = `<strong>Free trial: ${left} day${left === 1 ? "" : "s"} left.</strong> <button class="linklike" data-action="checkout">Subscribe for $20/month</button> to keep using Care Loop after that.`;
    } else if (account.access) html = "<strong>You're on a care team.</strong> Care Loop is free for people invited by a family caregiver.";
    else html = "<strong>Your free trial has ended.</strong>";
    if (account && !account.verified) {
      html += `<br><strong>Please confirm your email.</strong> We sent a link to ${h(account.user.email)}. <button class="linklike" data-action="resend-verification">Send it again</button>`;
    }
    trialBanner.innerHTML = html;
  }

  function renderAuth() {
    const mode = ui.authMode || "signup";
    const joining = !!pendingJoin();
    const intro = joining
      ? "<p class=\"notice ok-notice\">You've been invited to view and edit a patient's Care Loop profile as their doctor. Create a free account or log in to join.</p>"
      : "";
    if (mode === "forgot") {
      view.innerHTML = `
        <div class="signin">
          <h1>Reset your password</h1>
          <p>Enter your email and we'll send you a link to choose a new password.</p>
          <form class="card" data-form="forgot" novalidate>
            <div class="field"><label for="au-email">Email</label><input id="au-email" name="email" type="email" autocomplete="email" required></div>
            <p class="error-text" data-error hidden></p>
            <p class="form-status ok" data-ok hidden></p>
            <button class="btn" type="submit">Email me a reset link</button>
          </form>
          <p style="margin-top:1rem"><button class="linklike" data-action="auth-mode" data-mode="login">Back to log in</button></p>
        </div>`;
      return;
    }
    if (mode === "reset") {
      view.innerHTML = `
        <div class="signin">
          <h1>Choose a new password</h1>
          <p>For ${h(ui.reset?.email || "your account")}. This logs you out on every other device.</p>
          <form class="card" data-form="reset" novalidate>
            <div class="field"><label for="au-pw">New password <span class="hint">(at least ${MIN_PASSWORD} characters)</span></label>
              <input id="au-pw" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Save new password</button>
          </form>
        </div>`;
      return;
    }
    const signup = mode !== "login";
    view.innerHTML = `
      <div class="signin">
        ${intro}
        <h1>${signup ? (joining ? "Create your account" : "Start your free trial") : "Log in"}</h1>
        <p>${signup ? (joining ? "It's free for doctors invited by a family caregiver." : "Create your Care Loop account to start a 7-day free trial. <strong>No credit card needed.</strong>") : "Welcome back. Log in to your Care Loop account."}</p>
        <form class="card" data-form="${signup ? "signup" : "login"}" novalidate>
          ${signup ? '<div class="field"><label for="au-name">Your name</label><input id="au-name" name="name" autocomplete="name" required></div>' : ""}
          <div class="field"><label for="au-email">Email</label><input id="au-email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="au-pw">Password ${signup ? `<span class="hint">(at least ${MIN_PASSWORD} characters)</span>` : ""}</label>
            <input id="au-pw" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? MIN_PASSWORD : 1}" required></div>
          <p class="error-text" data-error hidden></p>
          <button class="btn" type="submit">${signup ? (joining ? "Create account" : "Create account and start trial") : "Log in"}</button>
        </form>
        <p style="margin-top:1rem">${signup
          ? 'Already have an account? <button class="linklike" data-action="auth-mode" data-mode="login">Log in</button>'
          : 'New to Care Loop? <button class="linklike" data-action="auth-mode" data-mode="signup">Create an account</button> · <button class="linklike" data-action="auth-mode" data-mode="forgot">Forgot your password?</button>'}</p>
      </div>`;
  }

  function renderPaywall() {
    view.innerHTML = `
      <div class="signin">
        <h1>${justSubscribed ? "Finishing your subscription" : "Your free trial has ended"}</h1>
        ${justSubscribed
          ? "<p>Thanks for subscribing! If Care Loop doesn't unlock in a moment, Whop may still be confirming your payment. Check again in a minute.</p>"
          : `<p>Hi ${h(account.user.name)}. Subscribe for <strong>$20/month</strong> to keep using Care Loop. Everything you entered is still saved.</p>`}
        <p><button class="btn" data-action="checkout">${justSubscribed ? "Go back to checkout" : "Continue to payment"}</button></p>
        <p class="hint">Secure checkout by Whop. Billed monthly, cancel anytime.</p>
        ${account.checkFailed ? '<p class="error-text">We couldn\'t reach Whop to check your subscription just now.</p>' : ""}
        <p style="margin-top:1.5rem">Already paid? <button class="linklike" data-action="recheck">Check my subscription again</button></p>
        <p class="hint">Signed in as ${h(account.user.email)}. Not you? <button class="linklike" data-action="signout">Log out</button></p>
      </div>`;
  }

  // ---------- rendering ----------
  function render() {
    document.getElementById("offline").hidden = navigator.onLine;
    renderTrialBanner();
    who.innerHTML = account
      ? `<span class="name">${h(account.user.name)}</span><button class="btn small secondary" data-action="signout">Log out</button>`
      : "";
    if (loading) { view.innerHTML = '<p class="hint" role="status">Loading…</p>'; return; }
    if (!account) return renderAuth();
    if (!account.access) return renderPaywall();
    if (!profilesLoaded) { view.innerHTML = '<p class="hint" role="status">Loading your profiles…</p>'; return; }
    const p = currentProfile();
    if (p && membership(p)) return renderProfile(p);
    ui.profileId = null;
    renderProfiles();
  }

  function renderProfiles() {
    const list = visibleProfiles();
    const joinWaiting = !!pendingJoin() && !account.verified;
    view.innerHTML = `
      <div class="profile-bar"><h1>Your care profiles</h1></div>
      ${pendingInvites ? `<div class="notice" style="margin-bottom:1rem">You've been invited to ${pendingInvites} care profile${pendingInvites === 1 ? "" : "s"}. Confirm your email address (check your inbox) to accept.</div>` : ""}
      ${joinWaiting ? '<div class="notice" style="margin-bottom:1rem">To join the patient profile from your doctor link, confirm your email address first (check your inbox), then reload this page.</div>' : ""}
      ${list.length ? `<div class="profiles">${list.map((p) => `
        <article class="card">
          <h2 style="font-size:1.3rem;margin:0" translate="no">${h(p.name)}</h2>
          <div><span class="pill accent">${h(ROLE_LABEL[myRole(p)])}</span> ${membership(p).status === "owner" ? '<span class="pill">Owner</span>' : ""}</div>
          <p class="meta" style="margin:0;color:var(--muted)">${p.team.filter((m) => m.status !== "contact").length} people with access · ${p.logs.length} log entries</p>
          <div><button class="btn small" data-action="open-profile" data-id="${p.id}">Open</button></div>
        </article>`).join("")}</div>`
        : account.ownerAccess
          ? `<div class="card"><p>You don't have any care profiles yet. Create one for the person you care for, or load a sample to look around.</p>
            <button class="btn secondary" data-action="load-sample">Load a sample profile</button></div>`
          : '<div class="card"><p>You\'re not on any care profiles right now.</p></div>'}
      ${account.ownerAccess ? `
      <details class="card" style="margin-top:1.25rem" ${list.length ? "" : "open"}>
        <summary>Create a new profile</summary>
        <p class="hint">You'll be the owner and family caregiver on this profile.</p>
        ${profileFields({})}
      </details>` : `<p class="hint" style="margin-top:1.25rem">Want to create profiles of your own? <button class="linklike" data-action="checkout">Subscribe for $20/month</button>.</p>`}`;
  }

  function profileFields(p, readOnly) {
    const dis = readOnly ? "disabled" : "";
    return `
      <form data-form="${p.id ? "profile-edit" : "profile-create"}" novalidate>
        <div class="row">
          <div class="field"><label for="pf-name">Patient's name</label><input id="pf-name" name="name" value="${h(p.name)}" required ${dis}></div>
          <div class="field"><label for="pf-dob">Date of birth</label><input id="pf-dob" name="dob" type="date" max="${todayISO()}" value="${h(p.dob)}" ${dis}></div>
        </div>
        <div class="field"><label for="pf-summary">Summary <span class="hint">(what someone new should know first)</span></label><textarea id="pf-summary" name="summary" ${dis}>${h(p.summary)}</textarea></div>
        <div class="row">
          <div class="field"><label for="pf-ecn">Emergency contact name</label><input id="pf-ecn" name="ecName" value="${h(p.emergency?.name)}" ${dis}></div>
          <div class="field"><label for="pf-ecp">Emergency contact phone</label><input id="pf-ecp" name="ecPhone" type="tel" autocomplete="off" value="${h(p.emergency?.phone)}" ${dis}></div>
        </div>
        ${p.id ? "" : `<div class="field"><label class="check"><input type="checkbox" name="authority" required> I confirm I have the authority to keep and share this person's health information.</label></div>`}
        <p class="error-text" data-error hidden></p>
        ${readOnly ? "" : `<button class="btn" type="submit">${p.id ? "Save details" : "Create profile"}</button>`}
      </form>`;
  }

  function renderProfile(p) {
    const role = myRole(p);
    view.innerHTML = `
      <p style="margin:0 0 0.5rem"><button class="btn ghost small" data-action="back">← All profiles</button></p>
      <div class="profile-bar">
        <div>
          <h1 translate="no">${h(p.name)}</h1>
          <div class="profile-meta">${p.dob ? "Born " + u(fmtDate(p.dob)) + " · " : ""}You're the <strong>${h(ROLE_LABEL[role].toLowerCase())}</strong> on this profile</div>
        </div>
        ${p.emergency?.name ? `<div class="card" style="padding:0.6rem 0.9rem"><div class="hint">Emergency contact</div><strong translate="no">${h(p.emergency.name)}</strong> · <a href="tel:${h(String(p.emergency.phone).replace(/[^\d+]/g, ""))}">${h(fmtPhone(p.emergency.phone))}</a></div>` : ""}
      </div>
      ${p.summary ? `<p translate="no">${h(p.summary)}</p>` : ""}
      <div class="tabs" role="tablist" aria-label="Profile sections">
        ${TABS.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${ui.tab === id}" tabindex="${ui.tab === id ? 0 : -1}" data-action="tab" data-tab="${id}">${label}</button>`).join("")}
      </div>
      <div id="panel" role="tabpanel" aria-labelledby="tab-${ui.tab}">${panel(p)}</div>`;
  }

  function panel(p) {
    switch (ui.tab) {
      case "schedule": return schedulePanel(p);
      case "medical": return medicalPanel(p);
      case "notes": return notesPanel(p);
      case "logs": return logsPanel(p);
      case "ai": return aiPanel(p);
      default: return teamPanel(p);
    }
  }

  const byline = (e) => `${u(e.byName)} · ${h(ROLE_LABEL[e.byRole] || "")} · ${u(fmtStamp(e.at))}`;
  const readOnlyNote = (what) => `<p class="read-only">Your role can view but not change ${what}.</p>`;
  const peopleOptions = (p, selected) => p.team.map((m) => `<option ${m.name === selected ? "selected" : ""}>${h(m.name)}</option>`).join("");

  function schedulePanel(p) {
    const editable = can(p, "editSchedule");
    const fu = can(p, "followups");
    const today = todayISO();
    const followups = [...p.followups].sort((a, b) => (a.done - b.done) || a.date.localeCompare(b.date));
    return `
      <div class="panel-grid">
        <section class="card wide">
          <h2 style="font-size:1.35rem">Weekly caregiver schedule</h2>
          <div class="week">
            ${DAYS.map((d) => {
              const shifts = p.shifts.filter((s) => s.day === d).sort((a, b) => a.start.localeCompare(b.start));
              return `<div class="day"><h4>${d}</h4>${shifts.map((s) => `
                <div class="shift"><b>${h(s.caregiver)}</b>${h(fmtTime(s.start))}–${h(fmtTime(s.end))}
                ${editable ? `<br><button class="btn small ghost" data-action="del-shift" data-id="${s.id}" aria-label="Remove ${h(s.caregiver)}'s ${d} shift">Remove</button>` : ""}</div>`).join("") || '<span class="hint">No shifts</span>'}</div>`;
            }).join("")}
          </div>
          ${editable ? `
          <form data-form="shift" class="row" style="margin-top:1rem;align-items:end" novalidate>
            <div class="field"><label for="sh-day">Day</label><select id="sh-day" name="day">${DAYS.map((d) => `<option>${d}</option>`).join("")}</select></div>
            <div class="field"><label for="sh-start">Start</label><input id="sh-start" name="start" type="time" value="09:00" required></div>
            <div class="field"><label for="sh-end">End</label><input id="sh-end" name="end" type="time" value="13:00" required></div>
            <div class="field"><label for="sh-who">Caregiver</label><select id="sh-who" name="caregiver">${peopleOptions(p)}</select></div>
            <div class="field"><button class="btn" type="submit">Add shift</button></div>
            <p class="error-text" data-error hidden style="grid-column:1/-1"></p>
          </form>` : readOnlyNote("the schedule")}
        </section>

        <section class="card wide">
          <h2 style="font-size:1.35rem">Follow-ups and pick-ups</h2>
          <ul class="list">
            ${followups.map((f) => {
              const overdue = !f.done && f.date < today;
              return `<li class="${f.done ? "done" : ""}">
                ${fu ? `<input type="checkbox" ${f.done ? "checked" : ""} data-action="toggle-followup" data-id="${f.id}" aria-label="Mark “${h(f.what)}” done">` : ""}
                <div class="main"><div class="title" translate="no">${h(f.what)}</div>
                <div class="meta">${f.kind === "pickup" ? "Prescription pick-up" : "Appointment"} · ${u(f.who)} · ${u(fmtDate(f.date))}
                  ${overdue ? ' <span class="pill warn">Overdue</span>' : ""}${f.done ? ' <span class="pill ok">Done</span>' : ""}</div>
                <div class="meta">Added by ${byline(f)}</div></div>
                ${fu ? `<div class="actions"><button class="btn small ghost" data-action="del-followup" data-id="${f.id}" aria-label="Delete “${h(f.what)}”">Delete</button></div>` : ""}
              </li>`;
            }).join("") || '<li class="empty">No follow-ups yet.</li>'}
          </ul>
          ${fu ? `
          <form data-form="followup" class="row" style="margin-top:1rem;align-items:end" novalidate>
            <div class="field"><label for="fu-kind">Type</label><select id="fu-kind" name="kind"><option value="appointment">Appointment</option><option value="pickup">Prescription pick-up</option></select></div>
            <div class="field" style="grid-column:span 2"><label for="fu-what">What</label><input id="fu-what" name="what" placeholder="e.g. Cardiology recheck" value="${h(ui.prefillWhat || "")}" required></div>
            <div class="field"><label for="fu-who">Who's responsible</label><select id="fu-who" name="who">${peopleOptions(p, me().name)}</select></div>
            <div class="field"><label for="fu-date">Date</label><input id="fu-date" name="date" type="date" value="${today}" required></div>
            <div class="field"><button class="btn" type="submit">Add</button></div>
            <p class="error-text" data-error hidden style="grid-column:1/-1"></p>
          </form>` : ""}
        </section>
      </div>`;
  }

  function medicalPanel(p) {
    const edit = can(p, "medical");
    const m = p.medical;
    return `
      <div class="panel-grid">
        <section class="card">
          <h2 style="font-size:1.35rem">Diagnoses</h2>
          <ul class="list">
            ${p.diagnoses.map((d) => `<li>
              <div class="main"><div class="title">${u(d.name)} <span class="pill ${d.status === "active" ? "accent" : ""}">${d.status === "active" ? "Active" : "Resolved"}</span></div>
              <div class="meta">${u(fmtDate(d.date))}${d.clinician ? " · " + u(d.clinician) : ""}</div>
              ${d.notes ? `<div translate="no">${h(d.notes)}</div>` : ""}
              <div class="meta">Added by ${byline(d)}</div></div>
              ${edit ? `<div class="actions"><button class="btn small secondary" data-action="toggle-dx" data-id="${d.id}">Mark ${d.status === "active" ? "resolved" : "active"}</button>
                <button class="btn small ghost" data-action="del-dx" data-id="${d.id}" aria-label="Delete ${h(d.name)}">Delete</button></div>` : ""}
            </li>`).join("") || '<li class="empty">No diagnoses recorded.</li>'}
          </ul>
          ${edit ? `
          <details style="margin-top:0.75rem"><summary>Add a diagnosis</summary>
          <form data-form="dx" novalidate>
            <div class="field"><label for="dx-name">Diagnosis</label><input id="dx-name" name="name" required></div>
            <div class="row">
              <div class="field"><label for="dx-date">Date</label><input id="dx-date" name="date" type="date" max="${todayISO()}" value="${todayISO()}" required></div>
              <div class="field"><label for="dx-status">Status</label><select id="dx-status" name="status"><option value="active">Active</option><option value="resolved">Resolved</option></select></div>
            </div>
            <div class="field"><label for="dx-clin">Diagnosing clinician</label><input id="dx-clin" name="clinician"></div>
            <div class="field"><label for="dx-notes">Notes</label><textarea id="dx-notes" name="notes"></textarea></div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Add diagnosis</button>
          </form></details>` : readOnlyNote("diagnoses")}
        </section>

        <section class="card">
          <h2 style="font-size:1.35rem">Medications</h2>
          <ul class="list">
            ${p.meds.map((x) => `<li>
              <div class="main"><div class="title" translate="no">${h(x.name)} ${x.dose ? "· " + h(x.dose) : ""}</div>
              <div class="meta">${u(x.timing)}${x.prescriber ? " · Prescribed by " + u(x.prescriber) : ""}</div>
              <div class="meta">Added by ${byline(x)}</div></div>
              ${edit ? `<div class="actions"><button class="btn small ghost" data-action="del-med" data-id="${x.id}" aria-label="Remove ${h(x.name)}">Remove</button></div>` : ""}
            </li>`).join("") || '<li class="empty">No medications recorded.</li>'}
          </ul>
          ${edit ? `
          <details style="margin-top:0.75rem"><summary>Add a medication</summary>
          <form data-form="med" novalidate>
            <div class="row">
              <div class="field"><label for="md-name">Name</label><input id="md-name" name="name" required></div>
              <div class="field"><label for="md-dose">Dose</label><input id="md-dose" name="dose" placeholder="e.g. 10 mg"></div>
            </div>
            <div class="row">
              <div class="field"><label for="md-timing">When</label><input id="md-timing" name="timing" placeholder="e.g. Every morning with food"></div>
              <div class="field"><label for="md-pres">Prescriber</label><input id="md-pres" name="prescriber"></div>
            </div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Add medication</button>
          </form></details>` : readOnlyNote("medications")}
        </section>
        ${edit ? scanCard(p) : ""}

        <section class="card wide">
          <h2 style="font-size:1.35rem">Allergies, mobility and daily needs</h2>
          <form data-form="medical-info" novalidate>
            <div class="row">
              <div class="field"><label for="mi-all">Allergies</label><textarea id="mi-all" name="allergies" ${edit ? "" : "disabled"}>${h(m.allergies)}</textarea></div>
              <div class="field"><label for="mi-mob">Mobility</label><textarea id="mi-mob" name="mobility" ${edit ? "" : "disabled"}>${h(m.mobility)}</textarea></div>
              <div class="field"><label for="mi-needs">Daily needs</label><textarea id="mi-needs" name="needs" ${edit ? "" : "disabled"}>${h(m.needs)}</textarea></div>
            </div>
            <div class="field" style="max-width:420px"><label for="mi-pcp">Primary physician</label><input id="mi-pcp" name="primary" value="${h(m.primary)}" ${edit ? "" : "disabled"}></div>
            ${edit ? '<button class="btn" type="submit">Save</button>' : readOnlyNote("this section")}
          </form>
        </section>
      </div>`;
  }

  function notesPanel(p) {
    const edit = can(p, "notes");
    const notes = [...p.notes].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
    const dxName = (id) => (p.diagnoses.find((d) => d.id === id) || {}).name;
    return `
      <div class="panel-grid">
        <section class="card">
          <h2 style="font-size:1.35rem">Notes</h2>
          <ul class="list">
            ${notes.map((n) => `<li><div class="main">
              <div class="title" translate="no">${h(fmtDate(n.date))} · ${h(n.doctor)}</div>
              ${n.dx && dxName(n.dx) ? `<div><span class="pill accent">${h(dxName(n.dx))}</span></div>` : ""}
              <div style="white-space:pre-wrap" translate="no">${h(n.text)}</div>
              <div class="meta">Added by ${byline(n)}</div></div>
              ${edit ? `<div class="actions"><button class="btn small ghost" data-action="del-note" data-id="${n.id}" aria-label="Delete note from ${h(fmtDate(n.date))}">Delete</button></div>` : ""}
            </li>`).join("") || '<li class="empty">No doctor\'s notes yet.</li>'}
          </ul>
          ${edit ? `
          <details style="margin-top:0.75rem" open><summary>Add a note</summary>
          <form data-form="note" novalidate>
            <div class="row">
              <div class="field"><label for="nt-date">Date</label><input id="nt-date" name="date" type="date" max="${todayISO()}" value="${todayISO()}" required></div>
              <div class="field"><label for="nt-doc">Doctor</label><input id="nt-doc" name="doctor" value="${myRole(p) === "physician" ? h(me().name) : ""}" required></div>
            </div>
            <div class="field"><label for="nt-dx">Related diagnosis <span class="hint">(optional)</span></label>
              <select id="nt-dx" name="dx"><option value="">None</option>${p.diagnoses.map((d) => `<option value="${d.id}">${h(d.name)}</option>`).join("")}</select></div>
            <div class="field"><label for="nt-text">Note</label><textarea id="nt-text" name="text" required></textarea></div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Add note</button>
          </form></details>` : readOnlyNote("doctor's notes")}
        </section>

        <section class="card">
          <h2 style="font-size:1.35rem">Charts and prescriptions</h2>
          <ul class="list">
            ${p.docs.map((d) => `<li><div class="main">
              <div class="title" translate="no">${h(d.name)}</div>
              <div class="meta"><span class="pill">${h(DOC_LABEL[d.label])}</span> ${h(fmtSize(d.size))}</div>
              <div class="meta">Uploaded by ${byline(d)}</div></div>
              <div class="actions"><button class="btn small secondary" data-action="open-doc" data-id="${d.id}">Open</button>
              ${edit ? `<button class="btn small ghost" data-action="del-doc" data-id="${d.id}" aria-label="Delete ${h(d.name)}">Delete</button>` : ""}</div>
            </li>`).join("") || '<li class="empty">Nothing uploaded yet.</li>'}
          </ul>
          ${edit ? `
          <form data-form="doc" style="margin-top:0.75rem" novalidate>
            <div class="field"><label for="dc-file">PDF or image <span class="hint">(up to 20 MB)</span></label><input id="dc-file" name="file" type="file" accept="application/pdf,image/*" required></div>
            <div class="field"><label for="dc-label">Label</label><select id="dc-label" name="label">${Object.entries(DOC_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Upload</button>
          </form>` : readOnlyNote("uploads")}
        </section>
      </div>`;
  }

  function logsPanel(p) {
    const edit = can(p, "logs");
    const logs = [...p.logs].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    return `
      <div class="panel-grid">
        <section class="card">
          <h2 style="font-size:1.35rem">Add a log entry</h2>
          ${edit ? `
          <form data-form="log" novalidate>
            <div class="field"><label for="lg-note">What happened</label><textarea id="lg-note" name="note" placeholder="e.g. Ate a full lunch, walked to the mailbox, mood good." required></textarea></div>
            <div class="row">
              <div class="field"><label for="lg-date">Date</label><input id="lg-date" name="date" type="date" max="${todayISO()}" value="${todayISO()}" required></div>
              <div class="field"><label for="lg-time">Time</label><input id="lg-time" name="time" type="time" value="${nowTime()}" required></div>
            </div>
            <p class="hint">Signed as ${h(me().name)} (${h(ROLE_LABEL[myRole(p)])}).</p>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Add log entry</button>
          </form>` : readOnlyNote("logs")}
        </section>
        <section class="card">
          <h2 style="font-size:1.35rem">Visit log</h2>
          <ul class="list">
            ${logs.map((l) => `<li><div class="main">
              <div class="title" translate="no">${h(fmtDate(l.date))}, ${h(fmtTime(l.time))}</div>
              <div style="white-space:pre-wrap" translate="no">${h(l.note)}</div>
              <div class="meta">${u(l.byName)} · ${h(ROLE_LABEL[l.byRole])}</div></div>
            </li>`).join("") || '<li class="empty">No log entries yet.</li>'}
          </ul>
        </section>
      </div>`;
  }

  function teamPanel(p) {
    const owner = can(p, "manageTeam");
    const now = Date.now();
    const statusPill = (m) => {
      if (m.status === "owner") return '<span class="pill accent">Owner</span>';
      if (m.status === "joined") return '<span class="pill ok">Has access</span>';
      if (m.status === "contact") return '<span class="pill">Contact, no account</span>';
      return new Date(m.expiresAt).getTime() < now ? '<span class="pill warn">Invite expired</span>' : `<span class="pill">Invited, expires <span translate="no">${h(new Date(m.expiresAt).toLocaleDateString(LOCALE))}</span></span>`;
    };
    const groups = ["family", "assisting", "physician"];
    return `
      <div class="panel-grid">
        <section class="card">
          <h2 style="font-size:1.35rem">Care team</h2>
          ${groups.map((g) => {
            const members = p.team.filter((m) => m.role === g);
            return `<h3 style="font-size:1rem;margin-top:1rem">${ROLE_LABEL[g]}s</h3>
            <ul class="list">${members.map((m) => `<li><div class="main">
              <div class="title">${u(m.name)} ${m.email === me()?.email ? '<span class="hint">(you)</span>' : ""}</div>
              <div class="meta" translate="no">${m.email ? h(m.email) : h(fmtPhone(m.phone))}</div>
              <div>${statusPill(m)}</div></div>
              ${owner && m.status !== "owner" ? `<div class="actions"><button class="btn small danger" data-action="remove-member" data-id="${m.id}" aria-label="Remove ${h(m.name)}">Remove</button></div>` : ""}
            </li>`).join("") || '<li class="empty">Nobody yet.</li>'}</ul>`;
          }).join("")}
        </section>

        <section class="card">
          ${owner ? `
          <h2 style="font-size:1.35rem">Invite someone</h2>
          <form data-form="invite" novalidate>
            <div class="row">
              <div class="field"><label for="iv-name">Name</label><input id="iv-name" name="name" required></div>
              <div class="field"><label for="iv-email">Email</label><input id="iv-email" name="email" type="email" required></div>
            </div>
            <div class="field"><label for="iv-role">Role</label><select id="iv-role" name="role">
              <option value="assisting">Assisting caregiver</option><option value="physician">Physician</option><option value="family">Family caregiver</option></select></div>
            <div class="field"><label class="check"><input type="checkbox" name="authority" required> I have the authority to share this person's health information with them.</label></div>
            <p class="hint">We'll email them an invitation. It expires after ${INVITE_DAYS} days. They accept by creating a free account (or logging in) with that email.</p>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Send invite</button>
          </form>
          <details style="margin-top:1rem"><summary>Add a contact without an account</summary>
          <form data-form="contact" novalidate>
            <div class="row">
              <div class="field"><label for="ct-name">Name</label><input id="ct-name" name="name" required></div>
              <div class="field"><label for="ct-phone">Phone</label><input id="ct-phone" name="phone" type="tel"></div>
            </div>
            <div class="field"><label for="ct-role">Group</label><select id="ct-role" name="role">
              <option value="family">Family</option><option value="assisting">Assisting caregiver</option><option value="physician">Physician</option></select></div>
            <p class="error-text" data-error hidden></p>
            <button class="btn" type="submit">Add contact</button>
          </form></details>
          ` : ""}
          <h2 style="font-size:1.35rem;${owner ? "margin-top:1.5rem" : ""}">Profile details</h2>
          ${profileFields(p, !can(p, "editProfile"))}
        </section>

        ${owner ? `
        <section class="card wide" id="share-doctor">
          <h2 style="font-size:1.35rem">Share with a doctor</h2>
          <p>Create a link you can send to a doctor or their office. When they open it and log in, they join this profile as a <strong>physician</strong>: they can see everything, and add or edit diagnoses, medications, doctor's notes and uploads. It's free for them.</p>
          <p class="hint">Anyone with the link can join, so only send it to the doctor. Links expire after 14 days, and you can revoke one or remove the doctor at any time.</p>
          ${ui.newLink && ui.newLink.profileId === p.id ? `
            <div class="field" style="margin-top:0.75rem"><label for="share-url">Doctor link</label>
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap"><input id="share-url" readonly value="${h(ui.newLink.url)}" style="flex:1;min-width:200px">
              <button class="btn small" data-action="copy-link">Copy link</button></div>
              <p class="hint">Copy it now: for security we won't show this link again.</p></div>` : ""}
          <button class="btn secondary" data-action="share-link">Create a doctor link</button>
          ${(p.shareLinks || []).length ? `
            <h3 style="font-size:1rem;margin-top:1.25rem">Active links</h3>
            <ul class="list">${p.shareLinks.map((l) => `<li><div class="main">
              <div class="title">Physician link</div>
              <div class="meta">Created <span translate="no">${h(fmtStamp(l.createdAt))}</span> by ${u(l.createdByName)} · expires <span translate="no">${h(new Date(l.expiresAt).toLocaleDateString(LOCALE))}</span></div></div>
              <div class="actions"><button class="btn small danger" data-action="revoke-link" data-id="${h(l.id)}">Revoke</button></div></li>`).join("")}</ul>` : ""}
        </section>
        <section class="card wide">
          <h2 style="font-size:1.35rem">History of changes</h2>
          <ul class="list">${p.history.slice(0, 50).map((x) => `<li><div class="main"><div>${h(x.text)}</div><div class="meta">${byline(x)}</div></div></li>`).join("") || '<li class="empty">No changes yet.</li>'}</ul>
          ${p.history.length > 50 ? `<p class="hint">Showing the latest 50 of ${p.history.length}. Export to see all.</p>` : ""}
        </section>
        <section class="card wide">
          <h2 style="font-size:1.35rem">Export or delete</h2>
          <p>Download everything in this profile as a file, or delete it permanently along with its uploaded files.</p>
          <div class="cta-row" style="margin-top:0"><button class="btn secondary" data-action="export">Export profile</button>
          <button class="btn danger" data-action="delete-profile">Delete profile</button></div>
        </section>` : ""}
      </div>`;
  }


  // ---------- AI assistant ----------
  const LANG_NAME = { en: "English" };
  const replyLanguage = () => {
    const code = window.CareLoopI18n?.lang || "en";
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || "English"; } catch { return LANG_NAME[code] || "English"; }
  };
  const aiState = (p) => (ui.ai ||= {})[p.id] ||= { days: 7, chat: loadChat(p.id) };
  function loadChat(id) { try { return JSON.parse(sessionStorage.getItem("careloop-chat-" + id)) || []; } catch { return []; } }
  function saveChat(id, chat) { try { sessionStorage.setItem("careloop-chat-" + id, JSON.stringify(chat.slice(-30))); } catch { /* ignore */ } }

  // Minimal formatting for the assistant's replies: escaped text, **bold**, and "- " bullet lists.
  function formatReply(text) {
    return String(text).split(/\n{2,}/).map((block) => {
      const lines = block.split("\n");
      const fmt = (t) => h(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${fmt(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
      return `<p>${lines.map(fmt).join("<br>")}</p>`;
    }).join("");
  }

  function aiPanel(p) {
    const st = aiState(p);
    const o = st.overview;
    const examples = [
      "Can these two medications be taken together?",
      "What changed this week?",
      "What should we ask at the next appointment?",
    ];
    return `
      <div class="panel-grid">
        <p class="notice wide" style="margin:0">The assistant can make mistakes and doesn't replace a doctor or pharmacist. Check with them before starting, stopping or changing any medication. <strong>In an emergency, call 911.</strong></p>
        <section class="card">
          <h2 style="font-size:1.35rem">Overview and next steps</h2>
          <form data-form="ai-overview" class="row" style="align-items:end" novalidate>
            <div class="field"><label for="ai-days">Period</label><select id="ai-days" name="days">
              ${[7, 14, 30].map((d) => `<option value="${d}" ${st.days === d ? "selected" : ""}>Last ${d} days</option>`).join("")}</select></div>
            <div class="field"><button class="btn" type="submit" ${st.loadingOverview ? "disabled" : ""}>${st.loadingOverview ? "Working…" : o ? "Refresh overview" : "Get overview"}</button></div>
          </form>
          ${st.overviewError ? `<p class="error-text">${h(st.overviewError)}</p>` : ""}
          ${st.loadingOverview ? '<p class="hint" role="status">Reading the profile… this can take up to a minute.</p>' : ""}
          ${o ? `<div class="ai-overview" translate="no">
            <p><strong>${h(o.headline)}</strong></p>
            ${o.happened.length ? `<h3>What happened</h3><ul>${o.happened.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
            ${o.watch.length ? `<h3>Keep an eye on</h3><ul>${o.watch.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
            ${o.suggestions.length ? `<h3>Suggested next steps</h3><ul class="list">${o.suggestions.map((x, i) => `<li><div class="main">
              <div class="title">${h(x.title)}</div><div>${h(x.detail)}</div>${x.who ? `<div class="meta">${h(x.who)}</div>` : ""}</div>
              ${can(p, "followups") ? `<div class="actions"><button class="btn small secondary" data-action="ai-to-followup" data-i="${i}">Add as follow-up</button></div>` : ""}</li>`).join("")}</ul>` : ""}
            ${o.askTheDoctor.length ? `<h3>Questions for the doctor</h3><ul>${o.askTheDoctor.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
          </div>` : !st.loadingOverview ? '<p class="hint">Get a summary of recent logs, notes and follow-ups, with suggestions for what to do next.</p>' : ""}
        </section>
        <section class="card">
          <h2 style="font-size:1.35rem">Ask Care Loop</h2>
          <div class="chat" id="ai-chat-log" aria-live="polite">
            ${st.chat.map((m) => `<div class="bubble ${m.role}" ${m.role === "assistant" ? 'translate="no"' : 'translate="no"'}>${m.role === "assistant" ? formatReply(m.content) : h(m.content)}</div>`).join("")}
            ${st.sending ? '<div class="bubble assistant typing" role="status">Thinking…</div>' : ""}
            ${!st.chat.length && !st.sending ? `<p class="hint">Ask about medications, symptoms in the logs, or what to bring up with the doctor. For example:</p>
              <div class="chips">${examples.map((x) => `<button class="chip" data-action="ai-example" data-text="${h(x)}">${h(x)}</button>`).join("")}</div>` : ""}
          </div>
          ${st.chatError ? `<p class="error-text">${h(st.chatError)}</p>` : ""}
          <form data-form="ai-chat" novalidate>
            <label for="ai-q" class="sr-only">Your question</label>
            <textarea id="ai-q" name="q" rows="2" placeholder="e.g. Can she take ibuprofen with lisinopril?" required>${h(st.draft || "")}</textarea>
            <div class="cta-row" style="margin-top:0.5rem">
              <button class="btn" type="submit" ${st.sending ? "disabled" : ""}>Send</button>
              ${st.chat.length ? '<button class="btn ghost" type="button" data-action="ai-clear">Clear chat</button>' : ""}
            </div>
            <p class="hint">Chats stay on this device and aren't saved to the profile.</p>
          </form>
        </section>
      </div>`;
  }

  async function sendChat(p, text) {
    const st = aiState(p);
    if (!navigator.onLine) { st.chatError = "You're offline."; return render(); }
    st.chat.push({ role: "user", content: text });
    st.sending = true; st.chatError = null; st.draft = "";
    render(); scrollChat();
    try {
      const { answer } = await api(`/api/ai?action=chat`, { method: "POST", body: { profileId: p.id, messages: st.chat, language: replyLanguage() } });
      st.chat.push({ role: "assistant", content: answer });
    } catch (err) {
      st.chat.pop();
      st.draft = text;
      st.chatError = err.message;
    }
    st.sending = false;
    saveChat(p.id, st.chat);
    if (ui.profileId === p.id && ui.tab === "ai") { render(); scrollChat(); document.getElementById("ai-q")?.focus(); }
  }
  const scrollChat = () => { const el = document.getElementById("ai-chat-log"); if (el) el.scrollTop = el.scrollHeight; };

  // ---------- prescription receipt scan ----------
  function scanCard(p) {
    const sc = ui.scan && ui.scan.profileId === p.id ? ui.scan : null;
    return `
        <section class="card wide" id="scan-card">
          <h2 style="font-size:1.35rem">Scan a prescription receipt</h2>
          <p>Take or choose a photo of a pharmacy receipt or bottle label. Care Loop reads the medications on it so you can check them and add them here.</p>
          <form data-form="scan" class="row" style="align-items:end" novalidate>
            <div class="field" style="grid-column:span 2"><label for="scan-photo">Photo</label><input id="scan-photo" name="photo" type="file" accept="image/*" capture="environment" required></div>
            <div class="field"><button class="btn" type="submit" ${sc?.loading ? "disabled" : ""}>${sc?.loading ? "Reading…" : "Read receipt"}</button></div>
            <p class="error-text" data-error ${sc?.error ? "" : "hidden"} style="grid-column:1/-1">${h(sc?.error || "")}</p>
          </form>
          ${sc && sc.meds ? `
            ${sc.message ? `<p class="hint">${h(sc.message)}</p>` : ""}
            ${sc.meds.length ? `
            <p class="notice">Check every line against the label before adding. A misread name or dose can be dangerous. You can fix anything below.</p>
            <ul class="list">${sc.meds.map((m, i) => `<li><input type="checkbox" id="scan-use-${i}" ${m.use ? "checked" : ""} data-scan-i="${i}" aria-label="Add this medication">
              <div class="main"><div class="row">
                <div class="field"><label for="scan-name-${i}">Name</label><input id="scan-name-${i}" value="${h(m.name)}" translate="no"></div>
                <div class="field"><label for="scan-dose-${i}">Dose</label><input id="scan-dose-${i}" value="${h(m.dose)}" translate="no"></div>
                <div class="field"><label for="scan-timing-${i}">When</label><input id="scan-timing-${i}" value="${h(m.timing)}" translate="no"></div>
                <div class="field"><label for="scan-pres-${i}">Prescriber</label><input id="scan-pres-${i}" value="${h(m.prescriber)}" translate="no"></div>
              </div>
              <div class="meta">${m.confidence === "low" ? '<span class="pill warn">Hard to read: double-check</span>' : m.confidence === "medium" ? '<span class="pill">Check carefully</span>' : '<span class="pill ok">Clearly printed</span>'}
                ${m.quantity ? ` · Qty <span translate="no">${h(m.quantity)}</span>` : ""}${m.fillDate ? ` · Filled <span translate="no">${h(m.fillDate)}</span>` : ""}</div></div></li>`).join("")}</ul>
            <div class="cta-row" style="margin-top:0.5rem"><button class="btn" data-action="scan-add">Add selected to medications</button>
              <button class="btn ghost" data-action="scan-discard">Discard</button></div>` : '<p>No medications found on that photo. Try a clearer, well-lit photo of the label.</p>'}` : ""}
          <p class="hint" style="margin-top:0.75rem">The photo is only used to read the medications. It isn't saved.</p>
        </section>`;
  }

  // Shrink the photo before sending: smaller upload, faster reading.
  async function photoToJpeg(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error("This photo format can't be read here. Please use a JPEG or PNG photo."); }
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  // ---------- form handling ----------
  function formError(form, msg) {
    const el = form.querySelector("[data-error]");
    if (el) { el.textContent = msg; el.hidden = false; }
    toast("Not saved: " + msg, true);
  }
  function requireFields(form, names) {
    for (const n of names) {
      const el = form.elements[n];
      if (!el || (el.type === "checkbox" ? !el.checked : !String(el.value).trim())) {
        el && el.focus();
        const label = el && form.querySelector(`label[for="${el.id}"]`);
        formError(form, el && el.type === "checkbox" ? "Please confirm the checkbox to continue." : `Please fill in ${label ? label.textContent.replace(/\(.*\)/, "").trim().toLowerCase() : n}.`);
        return false;
      }
    }
    return true;
  }
  const val = (form, n) => String(form.elements[n]?.value ?? "").trim();

  async function authSubmit(f, path, payload, welcome) {
    if (!navigator.onLine) return formError(f, "You're offline. Connect to the internet and try again.");
    const btn = f.querySelector("button[type=submit]");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Please wait…";
    try {
      account = await api(path, { method: "POST", body: payload });
      ui.profileId = null;
      ui.authMode = null;
      profilesLoaded = false;
      render();
      await afterSignIn();
      if (account.emailSent === false) toast("Account created, but we couldn't send the confirmation email yet. You can resend it from the banner.", true);
      else if (!document.querySelector(".toast.err")) toast(welcome);
      render();
    } catch (err) {
      formError(f, err.message);
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function createProfile(f, path, payload, message) {
    if (!navigator.onLine) return toast("Not saved: you're offline.", true);
    const btn = f?.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    try {
      const { profile } = await api(path, { method: "POST", body: payload });
      db.profiles.push(profile);
      ui.profileId = profile.id;
      ui.tab = "schedule";
      toast(message);
      render();
      window.scrollTo(0, 0);
    } catch (err) {
      if (f) formError(f, err.message); else toast("Not saved: " + err.message, true);
      if (btn) btn.disabled = false;
    }
  }

  const forms = {
    async "ai-overview"(f, p) {
      const st = aiState(p);
      st.days = Number(val(f, "days")) || 7;
      if (!navigator.onLine) { st.overviewError = "You're offline."; return render(); }
      st.loadingOverview = true; st.overviewError = null;
      render();
      try {
        const { overview } = await api(`/api/ai?action=overview`, { method: "POST", body: { profileId: p.id, days: st.days, language: replyLanguage() } });
        st.overview = overview;
      } catch (err) {
        st.overviewError = err.message;
      }
      st.loadingOverview = false;
      if (ui.profileId === p.id && ui.tab === "ai") render();
    },
    "ai-chat"(f, p) {
      const text = val(f, "q");
      if (!text) return;
      sendChat(p, text);
    },
    async scan(f, p) {
      const file = f.elements.photo.files[0];
      if (!file) return formError(f, "Please choose a photo.");
      if (!file.type.startsWith("image/")) return formError(f, "Please choose a photo (JPEG or PNG).");
      if (!navigator.onLine) return formError(f, "You're offline.");
      ui.scan = { profileId: p.id, loading: true };
      render();
      try {
        const image = await photoToJpeg(file);
        const r = await api(`/api/ai?action=scan-receipt`, { method: "POST", body: { profileId: p.id, image, mediaType: "image/jpeg" } });
        ui.scan = {
          profileId: p.id,
          message: r.readable ? r.message : r.message || "That photo couldn't be read as a prescription receipt.",
          meds: r.readable ? r.medications.map((m) => ({ ...m, use: m.confidence !== "low" })) : [],
        };
      } catch (err) {
        ui.scan = { profileId: p.id, error: err.message };
      }
      if (ui.profileId === p.id) { render(); document.getElementById("scan-card")?.scrollIntoView({ block: "start" }); }
    },

    async signup(f) {
      if (!requireFields(f, ["name", "email", "password"])) return;
      if (!validEmail(val(f, "email"))) return formError(f, "Please enter a valid email address.");
      if (f.elements.password.value.length < MIN_PASSWORD) return formError(f, `Please choose a password of at least ${MIN_PASSWORD} characters.`);
      await authSubmit(f, "/api/auth?action=signup", { name: val(f, "name"), email: val(f, "email"), password: f.elements.password.value }, pendingJoin() ? "Account created. Check your email to confirm it." : "Account created. Your 7-day free trial has started.");
    },
    async login(f) {
      if (!requireFields(f, ["email", "password"])) return;
      await authSubmit(f, "/api/auth?action=login", { email: val(f, "email"), password: f.elements.password.value }, "Welcome back.");
    },
    async forgot(f) {
      if (!requireFields(f, ["email"])) return;
      if (!validEmail(val(f, "email"))) return formError(f, "Please enter a valid email address.");
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { message } = await api("/api/auth?action=forgot", { method: "POST", body: { email: val(f, "email") } });
        const ok = f.querySelector("[data-ok]");
        ok.textContent = message;
        ok.hidden = false;
      } catch (err) {
        formError(f, err.message);
      } finally {
        btn.disabled = false;
      }
    },
    async reset(f) {
      const password = f.elements.password.value;
      if (password.length < MIN_PASSWORD) return formError(f, `Please choose a password of at least ${MIN_PASSWORD} characters.`);
      await authSubmit(f, "/api/auth?action=reset", { email: ui.reset?.email, token: ui.reset?.token, password }, "Password changed. You're logged in.");
    },
    async "profile-create"(f) {
      if (!requireFields(f, ["name", "authority"])) return;
      const draft = {
        id: uid(), name: val(f, "name"), dob: val(f, "dob"), summary: val(f, "summary"),
        emergency: { name: val(f, "ecName"), phone: val(f, "ecPhone") }, authority: true,
      };
      await createProfile(f, "/api/profiles?action=create", { profile: draft }, "Profile created");
    },
    "profile-edit"(f, p) {
      if (!requireFields(f, ["name"])) return;
      if (commit(p, "editProfile", "Updated profile details", () => {
        Object.assign(p, { name: val(f, "name"), dob: val(f, "dob"), summary: val(f, "summary"), emergency: { name: val(f, "ecName"), phone: val(f, "ecPhone") } });
      })) render();
    },
    shift(f, p) {
      const s = { id: uid(), day: val(f, "day"), start: val(f, "start"), end: val(f, "end"), caregiver: val(f, "caregiver") };
      if (!s.start || !s.end) return formError(f, "Please set a start and end time.");
      if (s.end <= s.start) return formError(f, "The end time must be after the start time.");
      if (!s.caregiver) return formError(f, "Add someone to the care team first.");
      if (commit(p, "editSchedule", `Added a ${s.day} shift for ${s.caregiver}`, () => p.shifts.push(s))) render();
    },
    followup(f, p) {
      if (!requireFields(f, ["what", "date"])) return;
      const x = { id: uid(), kind: val(f, "kind"), what: val(f, "what"), who: val(f, "who"), date: val(f, "date"), done: false, ...stamp() };
      if (commit(p, "followups", `Added follow-up “${x.what}”`, () => p.followups.push(x))) render();
    },
    dx(f, p) {
      if (!requireFields(f, ["name", "date"])) return;
      const x = { id: uid(), name: val(f, "name"), date: val(f, "date"), clinician: val(f, "clinician"), notes: val(f, "notes"), status: val(f, "status"), ...stamp() };
      if (commit(p, "medical", `Added diagnosis “${x.name}”`, () => p.diagnoses.push(x))) render();
    },
    med(f, p) {
      if (!requireFields(f, ["name"])) return;
      const x = { id: uid(), name: val(f, "name"), dose: val(f, "dose"), timing: val(f, "timing"), prescriber: val(f, "prescriber"), ...stamp() };
      if (commit(p, "medical", `Added medication ${x.name}${x.dose ? " " + x.dose : ""}`, () => p.meds.push(x))) render();
    },
    "medical-info"(f, p) {
      if (commit(p, "medical", "Updated allergies, mobility, daily needs or primary physician", () => {
        p.medical = { allergies: val(f, "allergies"), mobility: val(f, "mobility"), needs: val(f, "needs"), primary: val(f, "primary") };
      })) render();
    },
    note(f, p) {
      if (!requireFields(f, ["date", "doctor", "text"])) return;
      const x = { id: uid(), date: val(f, "date"), doctor: val(f, "doctor"), dx: val(f, "dx"), text: val(f, "text"), ...stamp() };
      if (commit(p, "notes", `Added a note from ${x.doctor}`, () => p.notes.push(x))) render();
    },
    async doc(f, p) {
      const file = f.elements.file.files[0];
      if (!file) return formError(f, "Please choose a file.");
      if (file.size > MAX_UPLOAD) return formError(f, "Files must be 20 MB or smaller.");
      if (!(file.type === "application/pdf" || file.type.startsWith("image/"))) return formError(f, "Only PDFs and images can be uploaded.");
      if (!navigator.onLine) return toast("Not saved: you're offline.", true);
      if (!can(p, "notes")) return toast("Not saved: your role can't upload files.", true);
      const x = { id: uid(), name: file.name, size: file.size, type: file.type, label: val(f, "label"), ...stamp() };
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Uploading… 0%";
      try {
        const safeName = file.name.replace(/[^\w.\- ]/g, "_").slice(-100) || "file";
        const blob = await window.BlobClient.upload(`files/${p.id}/${x.id}-${safeName}`, file, {
          access: "private",
          handleUploadUrl: "/api/files",
          clientPayload: JSON.stringify({ profileId: p.id }),
          contentType: file.type,
          multipart: file.size > 8 * 1024 * 1024,
          onUploadProgress: ({ percentage }) => { btn.textContent = `Uploading… ${Math.round(percentage)}%`; },
        });
        x.pathname = blob.pathname;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Upload";
        return formError(f, "The upload didn't finish. " + (err.message || ""));
      }
      if (commit(p, "notes", `Uploaded ${DOC_LABEL[x.label].toLowerCase()} “${x.name}”`, () => p.docs.push(x))) render();
    },
    log(f, p) {
      if (!requireFields(f, ["note", "date", "time"])) return;
      const x = { id: uid(), note: val(f, "note"), date: val(f, "date"), time: val(f, "time"), ...stamp() };
      if (new Date(`${x.date}T${x.time}`) > new Date()) return formError(f, "Log entries can't be in the future.");
      if (commit(p, "logs", "Added a log entry", () => p.logs.push(x))) render();
    },
    invite(f, p) {
      if (!requireFields(f, ["name", "email", "authority"])) return;
      const email = val(f, "email").toLowerCase();
      if (!validEmail(email)) return formError(f, "Please enter a valid email address.");
      const existing = p.team.find((m) => m.email === email);
      if (existing && existing.status !== "invited") return formError(f, "That person is already on the care team.");
      const m = { id: uid(), name: val(f, "name"), email, role: val(f, "role"), status: "invited", invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() };
      if (commit(p, "manageTeam", `Invited ${m.name} (${m.email}) as ${ROLE_LABEL[m.role].toLowerCase()}`, () => {
        if (existing) p.team.splice(p.team.indexOf(existing), 1);
        p.team.push(m);
      })) render();
    },
    contact(f, p) {
      if (!requireFields(f, ["name"])) return;
      const m = { id: uid(), name: val(f, "name"), email: null, phone: val(f, "phone"), role: val(f, "role"), status: "contact" };
      if (commit(p, "manageTeam", `Added contact ${m.name}`, () => p.team.push(m))) render();
    },
  };

  const actions = {
    "ai-example"(el, p) { aiState(p).draft = el.dataset.text; render(); const q = document.getElementById("ai-q"); q?.focus(); q?.setSelectionRange(q.value.length, q.value.length); },
    "ai-clear"(el, p) { const st = aiState(p); st.chat = []; st.chatError = null; saveChat(p.id, []); render(); },
    "ai-to-followup"(el, p) {
      const sug = aiState(p).overview?.suggestions?.[Number(el.dataset.i)];
      if (!sug) return;
      ui.prefillWhat = sug.title;
      ui.tab = "schedule";
      render();
      ui.prefillWhat = "";
      const input = document.getElementById("fu-what");
      input?.scrollIntoView({ block: "center" });
      input?.focus();
      toast("Pick who's responsible and a date, then press Add.");
    },
    "scan-discard"() { ui.scan = null; render(); },
    "scan-add"(el, p) {
      const sc = ui.scan;
      if (!sc?.meds) return;
      const picked = sc.meds.map((m, i) => ({
        use: document.getElementById(`scan-use-${i}`)?.checked,
        name: document.getElementById(`scan-name-${i}`)?.value.trim(),
        dose: document.getElementById(`scan-dose-${i}`)?.value.trim(),
        timing: document.getElementById(`scan-timing-${i}`)?.value.trim(),
        prescriber: document.getElementById(`scan-pres-${i}`)?.value.trim(),
      })).filter((m) => m.use && m.name);
      if (!picked.length) return toast("Tick at least one medication with a name.", true);
      const items = picked.map((m) => ({ id: uid(), name: m.name, dose: m.dose, timing: m.timing, prescriber: m.prescriber, source: "receipt scan", ...stamp() }));
      if (commit(p, "medical", `Added ${items.length} medication${items.length === 1 ? "" : "s"} from a receipt scan`, () => p.meds.push(...items))) {
        ui.scan = null;
        render();
      }
    },

    "auth-mode"(el) { ui.authMode = el.dataset.mode; render(); document.getElementById("au-email")?.focus(); },
    async signout() {
      try { await api("/api/auth?action=logout", { method: "POST" }); } catch { /* the cookie is cleared server-side; ignore */ }
      account = null; db.profiles = []; profilesLoaded = false; ui.profileId = null; ui.authMode = "login"; ui.newLink = null;
      render();
    },
    async "resend-verification"(el) {
      el.disabled = true;
      try {
        const r = await api("/api/auth?action=resend-verification", { method: "POST" });
        toast(r.alreadyVerified ? "Your email is already confirmed." : `Sent. Check your inbox at ${account.user.email}.`);
        if (r.alreadyVerified) loadAccount(false);
      } catch (err) {
        toast(err.message, true);
      }
      el.disabled = false;
    },
    async checkout(el) {
      if (el) el.disabled = true;
      try {
        const { url } = await api("/api/checkout", { method: "POST" });
        location.href = url;
      } catch (err) {
        toast(err.message, true);
        if (el) el.disabled = false;
      }
    },
    recheck() { loading = true; render(); loadAccount(true); },
    "load-sample"(el) {
      if (el) el.disabled = true;
      createProfile(null, "/api/profiles?action=sample", {}, "Sample profile loaded");
    },
    "open-profile"(el) { ui.profileId = el.dataset.id; ui.tab = "schedule"; render(); window.scrollTo(0, 0); },
    back() { ui.profileId = null; render(); },
    tab(el) { ui.tab = el.dataset.tab; render(); document.getElementById("tab-" + ui.tab)?.focus(); },
    "del-shift"(el, p) {
      const s = p.shifts.find((x) => x.id === el.dataset.id);
      if (s && commit(p, "editSchedule", `Removed ${s.caregiver}'s ${s.day} shift`, () => p.shifts.splice(p.shifts.indexOf(s), 1))) render();
    },
    "toggle-followup"(el, p) {
      const f = p.followups.find((x) => x.id === el.dataset.id);
      if (!f) return;
      if (commit(p, "followups", `Marked “${f.what}” ${f.done ? "not done" : "done"}`, () => { f.done = !f.done; })) render();
      else render();
    },
    "del-followup"(el, p) {
      const f = p.followups.find((x) => x.id === el.dataset.id);
      if (f && confirm(`Delete “${f.what}”?`) && commit(p, "followups", `Deleted follow-up “${f.what}”`, () => p.followups.splice(p.followups.indexOf(f), 1))) render();
    },
    "toggle-dx"(el, p) {
      const d = p.diagnoses.find((x) => x.id === el.dataset.id);
      if (d && commit(p, "medical", `Marked “${d.name}” ${d.status === "active" ? "resolved" : "active"}`, () => { d.status = d.status === "active" ? "resolved" : "active"; })) render();
    },
    "del-dx"(el, p) {
      const d = p.diagnoses.find((x) => x.id === el.dataset.id);
      if (d && confirm(`Delete diagnosis “${d.name}”?`) && commit(p, "medical", `Deleted diagnosis “${d.name}”`, () => p.diagnoses.splice(p.diagnoses.indexOf(d), 1))) render();
    },
    "del-med"(el, p) {
      const m = p.meds.find((x) => x.id === el.dataset.id);
      if (m && confirm(`Remove ${m.name}?`) && commit(p, "medical", `Removed medication ${m.name}`, () => p.meds.splice(p.meds.indexOf(m), 1))) render();
    },
    "del-note"(el, p) {
      const n = p.notes.find((x) => x.id === el.dataset.id);
      if (n && confirm("Delete this note?") && commit(p, "notes", `Deleted a note from ${n.doctor}`, () => p.notes.splice(p.notes.indexOf(n), 1))) render();
    },
    "open-doc"(el, p) {
      window.open(`/api/files?profile=${encodeURIComponent(p.id)}&doc=${encodeURIComponent(el.dataset.id)}`, "_blank", "noopener");
    },
    "del-doc"(el, p) {
      const d = p.docs.find((x) => x.id === el.dataset.id);
      if (d && confirm(`Delete “${d.name}”?`) && commit(p, "notes", `Deleted upload “${d.name}”`, () => p.docs.splice(p.docs.indexOf(d), 1))) render();
    },
    async "share-link"(el, p) {
      if (!can(p, "manageTeam")) return toast("Only the owner can share this profile.", true);
      el.disabled = true;
      try {
        const { url, profile } = await api(`/api/profiles?id=${encodeURIComponent(p.id)}&action=share-link`, { method: "POST" });
        replaceProfile(p, profile);
        ui.newLink = { profileId: p.id, url };
        render();
        document.getElementById("share-url")?.select();
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
      }
    },
    async "copy-link"() {
      const input = document.getElementById("share-url");
      try { await navigator.clipboard.writeText(input.value); toast("Link copied"); }
      catch { input.select(); toast("Press Ctrl+C (or ⌘C) to copy the selected link."); }
    },
    async "revoke-link"(el, p) {
      if (!confirm("Revoke this doctor link? Anyone who hasn't used it yet won't be able to join. Doctors who already joined stay on the team.")) return;
      try {
        const { profile } = await api(`/api/profiles?id=${encodeURIComponent(p.id)}&action=revoke-link`, { method: "POST", body: { linkId: el.dataset.id } });
        replaceProfile(p, profile);
        ui.newLink = null;
        toast("Link revoked");
        render();
      } catch (err) {
        toast(err.message, true);
      }
    },
    "remove-member"(el, p) {
      const m = p.team.find((x) => x.id === el.dataset.id);
      if (m && confirm(`Remove ${m.name} from the care team? They will lose access.`) && commit(p, "manageTeam", `Removed ${m.name} from the care team`, () => p.team.splice(p.team.indexOf(m), 1))) render();
    },
    export(el, p) {
      if (!can(p, "editProfile")) return;
      const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `careloop-${p.name.replace(/[^\w]+/g, "-").toLowerCase()}-${todayISO()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
    async "delete-profile"(el, p) {
      const typed = prompt(`This permanently deletes ${p.name}'s profile and every uploaded file. Type DELETE to confirm.`);
      if (typed !== "DELETE") return;
      if (!can(p, "deleteProfile")) return toast("Not deleted: only the owner can delete a profile.", true);
      try {
        await api(`/api/profiles?id=${encodeURIComponent(p.id)}`, { method: "DELETE" });
        db.profiles = db.profiles.filter((x) => x !== p);
        ui.profileId = null;
        toast("Profile deleted");
        render();
      } catch (err) {
        toast("Not deleted: " + err.message, true);
      }
    },
  };

  // ---------- events ----------
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("form[data-form]");
    if (!f || !forms[f.dataset.form]) return;
    e.preventDefault();
    const err = f.querySelector("[data-error]");
    if (err) err.hidden = true;
    forms[f.dataset.form](f, currentProfile());
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.type === "checkbox") return;
    actions[el.dataset.action]?.(el, currentProfile());
  });
  // Enter sends a chat message; Shift+Enter adds a new line.
  document.addEventListener("keydown", (e) => {
    if (e.target.id === "ai-q" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "ai-q") { const p = currentProfile(); if (p) aiState(p).draft = e.target.value; }
  });
  document.addEventListener("change", (e) => {
    const el = e.target.closest('input[type="checkbox"][data-action]');
    if (el) actions[el.dataset.action]?.(el, currentProfile());
  });
  document.addEventListener("keydown", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const ids = TABS.map((t) => t[0]);
    let i = ids.indexOf(ui.tab);
    i = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    actions.tab({ dataset: { tab: ids[i] } });
  });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  // Coming back to the tab: pick up changes other people made in the meantime.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !account?.access || savingIds.size || document.activeElement?.closest("form")) return;
    await loadProfiles();
    render();
  });

  render();
  loadAccount(justSubscribed).then(() => {
    if (justSubscribed && account?.subscribed) { history.replaceState(null, "", location.pathname); toast("Subscription confirmed. Thank you!"); }
    if (verifiedParam === "1") toast("Email confirmed. Thank you!");
    if (verifiedParam === "0") toast("That confirmation link has expired. Use “Send it again” in the banner.", true);
  });
  // Re-check access every 10 minutes so an ended trial or cancelled subscription locks the app.
  setInterval(() => { if (account && !document.querySelector("form[data-form] input:focus")) loadAccount(false); }, 600000);
})();
