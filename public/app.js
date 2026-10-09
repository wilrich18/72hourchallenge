/* Care Loop web app (early version).
 * Everything is stored in this browser (localStorage, plus IndexedDB for uploaded files).
 * Roles and permissions follow the PRD's proposed permissions table, but they are only
 * enforced in the browser here; the real release must enforce them on the server (P2).
 */
(() => {
  "use strict";

  const STORE_KEY = "careloop-demo-v1";
  const TRIAL_KEY = "careloop-trial-v1";
  const TRIAL_DAYS = 7;
  const RECHECK_MS = 3 * 86400000;
  const CHECKOUT_URL = "https://whop.com/checkout/ch_hxaIOuGRbiYUxHr/";
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
  let db = load();

  // ---------- helpers ----------
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const localISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString(); };
  const todayISO = () => localISO().slice(0, 10);
  const nowTime = () => localISO().slice(11, 16);
  const fmtDate = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
  const fmtStamp = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtTime = (t) => { if (!t) return ""; const [hh, mm] = t.split(":").map(Number); return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
  const fmtPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`; return p || ""; };
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB";

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through */ }
    return { session: null, users: {}, profiles: [] };
  }
  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  function toast(msg, isErr) {
    const region = document.getElementById("toast-region");
    region.innerHTML = `<div class="toast${isErr ? " err" : ""}" role="${isErr ? "alert" : "status"}">${h(msg)}</div>`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { region.innerHTML = ""; }, isErr ? 6000 : 2200);
  }

  const me = () => db.session && db.users[db.session];
  const stamp = () => ({ byName: me().name, byEmail: me().email, byRole: myRole(currentProfile()) || "family", at: new Date().toISOString() });
  const currentProfile = () => db.profiles.find((p) => p.id === ui.profileId) || null;

  function membership(p, email = db.session) {
    return p.team.find((m) => m.email && m.email === email && (m.status === "owner" || m.status === "joined"));
  }
  function myRole(p) { const m = p && membership(p); return m ? m.role : null; }
  function can(p, action) { const r = myRole(p); return !!r && PERMS[r].includes(action); }
  const visibleProfiles = () => db.profiles.filter((p) => membership(p));

  // Every change goes through here: role check, offline check, history entry, save, rollback on failure.
  function commit(p, action, historyText, mutate) {
    if (!navigator.onLine) { toast("Not saved: you're offline.", true); return false; }
    if (p && !can(p, action)) { toast("Not saved: your role can't make this change.", true); return false; }
    const before = clone(db);
    try {
      mutate();
      if (p) p.history.unshift({ id: uid(), text: historyText, ...stamp() });
      persist();
      toast("Saved");
      return true;
    } catch (err) {
      db = before;
      toast("Not saved: " + (err.name === "QuotaExceededError" ? "this browser's storage is full." : err.message), true);
      return false;
    }
  }

  // ---------- IndexedDB for uploads ----------
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("careloop-files", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => open().then((d) => new Promise((res, rej) => {
      const t = d.transaction("files", mode);
      const req = fn(t.objectStore("files"));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    }));
    return {
      put: (id, blob) => tx("readwrite", (s) => s.put(blob, id)),
      get: (id) => tx("readonly", (s) => s.get(id)),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  // ---------- free trial and subscription ----------
  // The trial starts the first time this browser opens the app. After TRIAL_DAYS the app
  // is locked until the visitor confirms, by email, an active Whop subscription.
  function loadTrial() {
    let t = null;
    try { t = JSON.parse(localStorage.getItem(TRIAL_KEY)); } catch { /* start fresh */ }
    if (!t || !t.startedAt) { t = { startedAt: Date.now() }; saveTrial(t); }
    return t;
  }
  function saveTrial(t) {
    try { localStorage.setItem(TRIAL_KEY, JSON.stringify(t)); } catch { /* ignore */ }
  }
  let trial = loadTrial();
  const trialDaysLeft = () => Math.max(0, Math.ceil((trial.startedAt + TRIAL_DAYS * 86400000 - Date.now()) / 86400000));
  const isSubscribed = () => !!trial.paidEmail;
  const justSubscribed = new URLSearchParams(location.search).has("subscribed");

  async function verifySubscription(email) {
    const r = await fetch("/api/verify-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong.");
    return !!data.active;
  }

  // Re-check a saved subscription every few days so a cancelled one locks again.
  // A network failure keeps access; only a clear "not active" from Whop removes it.
  async function recheckSubscription() {
    if (!isSubscribed() || Date.now() - (trial.verifiedAt || 0) < RECHECK_MS) return;
    try {
      const active = await verifySubscription(trial.paidEmail);
      trial = active ? { ...trial, verifiedAt: Date.now() } : { startedAt: trial.startedAt };
      saveTrial(trial);
      if (!active) render();
    } catch { /* try again next time */ }
  }

  function renderTrialBanner() {
    if (isSubscribed()) {
      trialBanner.innerHTML = "<strong>You're subscribed to Care Loop.</strong> Thank you!";
    } else {
      const left = trialDaysLeft();
      trialBanner.innerHTML = left > 0
        ? `<strong>Free trial: ${left} day${left === 1 ? "" : "s"} left.</strong> <a href="${CHECKOUT_URL}">Subscribe for $20/month</a> to keep using Care Loop after that. <button class="linklike" data-action="show-unlock">Already subscribed?</button>`
        : "<strong>Your free trial has ended.</strong>";
    }
  }

  function renderPaywall() {
    const ended = trialDaysLeft() === 0;
    view.innerHTML = `
      <div class="signin">
        <h1>${justSubscribed ? "Thanks for subscribing!" : ended ? "Your free trial has ended" : "Already subscribed?"}</h1>
        ${justSubscribed
          ? "<p>Enter the email address you used at checkout to unlock Care Loop on this browser.</p>"
          : ended
            ? `<p>Subscribe for <strong>$20/month</strong> to keep using Care Loop. Everything you entered is still saved in this browser.</p>
               <p><a class="btn" href="${CHECKOUT_URL}">Subscribe for $20/month</a></p>
               <p class="hint">Billed monthly through Whop. Cancel anytime.</p>
               <h2 style="font-size:1.2rem;margin-top:1.5rem">Already subscribed?</h2>`
            : "<p>Enter the email address you used at checkout to unlock Care Loop on this browser.</p>"}
        <form class="card" data-form="unlock" novalidate>
          <div class="field"><label for="ul-email">Email used at checkout</label><input id="ul-email" name="email" type="email" autocomplete="email" required></div>
          <p class="error-text" data-error hidden></p>
          <button class="btn" type="submit">Unlock Care Loop</button>
        </form>
        ${ended ? "" : '<p style="margin-top:1rem"><button class="btn ghost" data-action="hide-unlock">← Back to Care Loop</button></p>'}
      </div>`;
  }

  // ---------- rendering ----------
  function render() {
    document.getElementById("offline").hidden = navigator.onLine;
    renderTrialBanner();
    if (!isSubscribed() && (trialDaysLeft() === 0 || ui.unlock)) {
      who.innerHTML = "";
      return renderPaywall();
    }
    const u = me();
    who.innerHTML = u
      ? `<span class="name">${h(u.name)}</span><button class="btn small secondary" data-action="signout">Sign out</button>`
      : "";
    if (!u) return renderSignIn();
    const p = currentProfile();
    if (p && membership(p)) return renderProfile(p);
    ui.profileId = null;
    renderProfiles();
  }

  function renderSignIn() {
    const known = Object.values(db.users);
    view.innerHTML = `
      <div class="signin">
        <h1>Sign in</h1>
        <p class="hint">No password needed in this early version. Enter your name and email to get started. Verified accounts, password reset and two-step sign-in are coming.</p>
        <form class="card" data-form="signin" novalidate>
          <div class="field"><label for="si-name">Your name</label><input id="si-name" name="name" autocomplete="name" required></div>
          <div class="field"><label for="si-email">Email</label><input id="si-email" name="email" type="email" autocomplete="email" required></div>
          <p class="error-text" data-error hidden></p>
          <button class="btn" type="submit">Sign in</button>
        </form>
        ${known.length ? `
          <h2 style="font-size:1.2rem;margin-top:1.5rem">Switch to someone who has signed in here</h2>
          <ul class="list card">${known.map((u) => `
            <li><div class="main"><div class="title">${h(u.name)}</div><div class="meta">${h(u.email)}</div></div>
            <div class="actions"><button class="btn small secondary" data-action="quick-signin" data-email="${h(u.email)}">Sign in</button></div></li>`).join("")}
          </ul>` : ""}
        <p style="margin-top:1.5rem"><button class="btn ghost" data-action="sample-signin">Or explore a sample profile as a family caregiver →</button></p>
      </div>`;
  }

  function renderProfiles() {
    const list = visibleProfiles();
    const pending = db.profiles.filter((p) => p.team.some((m) => m.email === db.session && m.status === "invited"));
    view.innerHTML = `
      <div class="profile-bar"><h1>Your care profiles</h1></div>
      ${pending.length ? `<div class="notice" style="margin-bottom:1rem">You have ${pending.length} invitation(s) that expired. Ask the family caregiver to invite you again.</div>` : ""}
      ${list.length ? `<div class="profiles">${list.map((p) => `
        <article class="card">
          <h2 style="font-size:1.3rem;margin:0">${h(p.name)}</h2>
          <div><span class="pill accent">${h(ROLE_LABEL[myRole(p)])}</span> ${membership(p).status === "owner" ? '<span class="pill">Owner</span>' : ""}</div>
          <p class="meta" style="margin:0;color:var(--muted)">${p.team.filter((m) => m.status !== "contact").length} people with access · ${p.logs.length} log entries</p>
          <div><button class="btn small" data-action="open-profile" data-id="${p.id}">Open</button></div>
        </article>`).join("")}</div>`
        : `<div class="card"><p>You don't have any care profiles yet. Create one for the person you care for, or load a sample to look around.</p>
            <button class="btn secondary" data-action="load-sample">Load a sample profile</button></div>`}
      <details class="card" style="margin-top:1.25rem" ${list.length ? "" : "open"}>
        <summary>Create a new profile</summary>
        <p class="hint">You'll be the owner and family caregiver on this profile.</p>
        ${profileFields({})}
      </details>`;
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
          <h1>${h(p.name)}</h1>
          <div class="profile-meta">${p.dob ? "Born " + h(fmtDate(p.dob)) + " · " : ""}You're the <strong>${h(ROLE_LABEL[role].toLowerCase())}</strong> on this profile</div>
        </div>
        ${p.emergency?.name ? `<div class="card" style="padding:0.6rem 0.9rem"><div class="hint">Emergency contact</div><strong>${h(p.emergency.name)}</strong> · <a href="tel:${h(String(p.emergency.phone).replace(/[^\d+]/g, ""))}">${h(fmtPhone(p.emergency.phone))}</a></div>` : ""}
      </div>
      ${p.summary ? `<p>${h(p.summary)}</p>` : ""}
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
      default: return teamPanel(p);
    }
  }

  const byline = (e) => `${h(e.byName)} · ${h(ROLE_LABEL[e.byRole] || "")} · ${h(fmtStamp(e.at))}`;
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
                <div class="main"><div class="title">${h(f.what)}</div>
                <div class="meta">${f.kind === "pickup" ? "Prescription pick-up" : "Appointment"} · ${h(f.who)} · ${h(fmtDate(f.date))}
                  ${overdue ? ' <span class="pill warn">Overdue</span>' : ""}${f.done ? ' <span class="pill ok">Done</span>' : ""}</div>
                <div class="meta">Added by ${byline(f)}</div></div>
                ${fu ? `<div class="actions"><button class="btn small ghost" data-action="del-followup" data-id="${f.id}" aria-label="Delete “${h(f.what)}”">Delete</button></div>` : ""}
              </li>`;
            }).join("") || '<li class="empty">No follow-ups yet.</li>'}
          </ul>
          ${fu ? `
          <form data-form="followup" class="row" style="margin-top:1rem;align-items:end" novalidate>
            <div class="field"><label for="fu-kind">Type</label><select id="fu-kind" name="kind"><option value="appointment">Appointment</option><option value="pickup">Prescription pick-up</option></select></div>
            <div class="field" style="grid-column:span 2"><label for="fu-what">What</label><input id="fu-what" name="what" placeholder="e.g. Cardiology recheck" required></div>
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
              <div class="main"><div class="title">${h(d.name)} <span class="pill ${d.status === "active" ? "accent" : ""}">${d.status === "active" ? "Active" : "Resolved"}</span></div>
              <div class="meta">${h(fmtDate(d.date))}${d.clinician ? " · " + h(d.clinician) : ""}</div>
              ${d.notes ? `<div>${h(d.notes)}</div>` : ""}
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
              <div class="main"><div class="title">${h(x.name)} ${x.dose ? "· " + h(x.dose) : ""}</div>
              <div class="meta">${h(x.timing)}${x.prescriber ? " · Prescribed by " + h(x.prescriber) : ""}</div>
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
              <div class="title">${h(fmtDate(n.date))} · ${h(n.doctor)}</div>
              ${n.dx && dxName(n.dx) ? `<div><span class="pill accent">${h(dxName(n.dx))}</span></div>` : ""}
              <div style="white-space:pre-wrap">${h(n.text)}</div>
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
              <div class="title">${h(d.name)}</div>
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
              <div class="title">${h(fmtDate(l.date))}, ${h(fmtTime(l.time))}</div>
              <div style="white-space:pre-wrap">${h(l.note)}</div>
              <div class="meta">${h(l.byName)} · ${h(ROLE_LABEL[l.byRole])}</div></div>
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
      return new Date(m.expiresAt).getTime() < now ? '<span class="pill warn">Invite expired</span>' : `<span class="pill">Invited, expires ${h(new Date(m.expiresAt).toLocaleDateString())}</span>`;
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
              <div class="title">${h(m.name)} ${m.email === db.session ? '<span class="hint">(you)</span>' : ""}</div>
              <div class="meta">${m.email ? h(m.email) : h(fmtPhone(m.phone))}</div>
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
            <p class="hint">Invitations expire after ${INVITE_DAYS} days. For now, the person accepts by signing in on this browser with that email.</p>
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

  // ---------- sample data ----------
  function sampleProfile(u) {
    const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
    const at = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
    const fam = { byName: u.name, byEmail: u.email, byRole: "family" };
    const aide = { byName: "Maria Lopez", byEmail: "maria@example.com", byRole: "assisting" };
    const doc = { byName: "Dr. Ada Okafor", byEmail: "dr.okafor@example.com", byRole: "physician" };
    const dx1 = uid(), dx2 = uid();
    return {
      id: uid(), name: "Eleanor Hughes (sample)", dob: "1941-03-12",
      summary: "Lives at home with her daughter. Hard of hearing on the left side, so speak on her right. Likes a short walk after lunch.",
      emergency: { name: u.name, phone: "5551234567" },
      team: [
        { id: uid(), name: u.name, email: u.email, role: "family", status: "owner" },
        { id: uid(), name: "Maria Lopez", email: "maria@example.com", role: "assisting", status: "joined" },
        { id: uid(), name: "Dr. Ada Okafor", email: "dr.okafor@example.com", role: "physician", status: "joined" },
        { id: uid(), name: "Sam Hughes", email: null, phone: "5559876543", role: "family", status: "contact" },
      ],
      shifts: [
        { id: uid(), day: "Monday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
        { id: uid(), day: "Wednesday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
        { id: uid(), day: "Friday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
        { id: uid(), day: "Saturday", start: "10:00", end: "16:00", caregiver: "Sam Hughes" },
        { id: uid(), day: "Sunday", start: "10:00", end: "16:00", caregiver: u.name },
      ],
      followups: [
        { id: uid(), kind: "pickup", what: "Pick up lisinopril refill", who: "Sam Hughes", date: d(-2), done: false, ...fam, at: at(-6) },
        { id: uid(), kind: "appointment", what: "Blood pressure recheck with Dr. Okafor", who: u.name, date: d(12), done: false, ...doc, at: at(-3) },
        { id: uid(), kind: "appointment", what: "Physical therapy evaluation", who: u.name, date: d(-9), done: true, ...fam, at: at(-20) },
      ],
      diagnoses: [
        { id: dx1, name: "High blood pressure", date: "2019-06-04", clinician: "Dr. Ada Okafor", notes: "Managed with medication.", status: "active", ...doc, at: at(-30) },
        { id: dx2, name: "Urinary tract infection", date: d(-40), clinician: "Urgent care", notes: "Finished antibiotics.", status: "resolved", ...fam, at: at(-40) },
      ],
      meds: [
        { id: uid(), name: "Lisinopril", dose: "20 mg", timing: "Every morning", prescriber: "Dr. Ada Okafor", ...doc, at: at(-3) },
        { id: uid(), name: "Vitamin D", dose: "1000 IU", timing: "With breakfast", prescriber: "", ...fam, at: at(-30) },
      ],
      medical: { allergies: "Penicillin (rash)", mobility: "Walks with a walker. Needs a hand on stairs.", needs: "Help with showering. Reminders for afternoon fluids.", primary: "Dr. Ada Okafor" },
      notes: [
        { id: uid(), date: d(-3), doctor: "Dr. Ada Okafor", dx: dx1, text: "Blood pressure still high at 152/90. Increasing lisinopril from 10 mg to 20 mg each morning. Recheck in 2 weeks. Please log any dizziness.", ...doc, at: at(-3) },
      ],
      docs: [],
      logs: [
        { id: uid(), note: "Took morning meds with breakfast. Walked to the mailbox and back with the walker. In good spirits.", date: d(-1), time: "10:15", ...aide, at: at(-1) },
        { id: uid(), note: "A little dizzy standing up after lunch. Sat for five minutes and it passed. Noting for Dr. Okafor.", date: d(-1), time: "13:20", ...aide, at: at(-1) },
        { id: uid(), note: "Quiet evening. Ate most of dinner.", date: d(-2), time: "19:00", ...fam, at: at(-2) },
      ],
      history: [{ id: uid(), text: "Created the sample profile", ...fam, at: new Date().toISOString() }],
    };
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

  function signIn(name, email) {
    email = email.toLowerCase();
    db.users[email] = { name, email };
    db.session = email;
    const now = Date.now();
    // Accept any open invitations for this email.
    db.profiles.forEach((p) => p.team.forEach((m) => {
      if (m.email === email && m.status === "invited" && new Date(m.expiresAt).getTime() >= now) {
        m.status = "joined";
        p.history.unshift({ id: uid(), text: `${name} accepted the invitation`, byName: name, byEmail: email, byRole: m.role, at: new Date().toISOString() });
      }
    }));
    persist();
  }

  const forms = {
    async unlock(f) {
      if (!requireFields(f, ["email"])) return;
      const email = val(f, "email").toLowerCase();
      if (!validEmail(email)) return formError(f, "Please enter a valid email address.");
      if (!navigator.onLine) return formError(f, "You're offline. Connect to the internet and try again.");
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        if (!(await verifySubscription(email))) {
          return formError(f, "We couldn't find an active subscription for that email. Use the email from your Whop receipt, or subscribe first.");
        }
        trial = { ...trial, paidEmail: email, verifiedAt: Date.now() };
        saveTrial(trial);
        ui.unlock = false;
        if (justSubscribed) history.replaceState(null, "", location.pathname);
        toast("Subscription confirmed. Thank you!");
        render();
      } catch (err) {
        formError(f, err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Unlock Care Loop";
      }
    },
    signin(f) {
      if (!requireFields(f, ["name", "email"])) return;
      if (!validEmail(val(f, "email"))) return formError(f, "Please enter a valid email address.");
      signIn(val(f, "name"), val(f, "email"));
      ui.profileId = null;
      render();
    },
    "profile-create"(f) {
      if (!requireFields(f, ["name", "authority"])) return;
      const u = me();
      const p = {
        id: uid(), name: val(f, "name"), dob: val(f, "dob"), summary: val(f, "summary"),
        emergency: { name: val(f, "ecName"), phone: val(f, "ecPhone") },
        team: [{ id: uid(), name: u.name, email: u.email, role: "family", status: "owner" }],
        shifts: [], followups: [], diagnoses: [], meds: [], medical: { allergies: "", mobility: "", needs: "", primary: "" },
        notes: [], docs: [], logs: [], history: [],
      };
      if (commit(null, null, null, () => {
        p.history.push({ id: uid(), text: "Created the profile", byName: u.name, byEmail: u.email, byRole: "family", at: new Date().toISOString() });
        db.profiles.push(p);
      })) { ui.profileId = p.id; ui.tab = "schedule"; render(); }
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
      const x = { id: uid(), name: file.name, size: file.size, type: file.type, label: val(f, "label"), ...stamp() };
      try { await idb.put(x.id, file); } catch (err) { return formError(f, "This browser couldn't store the file."); }
      if (commit(p, "notes", `Uploaded ${DOC_LABEL[x.label].toLowerCase()} “${x.name}”`, () => p.docs.push(x))) render();
      else idb.del(x.id).catch(() => {});
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
    "show-unlock"() { ui.unlock = true; render(); },
    "hide-unlock"() { ui.unlock = false; render(); },
    signout() { db.session = null; persist(); ui.profileId = null; render(); },
    "quick-signin"(el) { const u = db.users[el.dataset.email]; signIn(u.name, u.email); render(); },
    "sample-signin"() {
      signIn("Jordan Hughes", "jordan@example.com");
      if (!visibleProfiles().length) actions["load-sample"]();
      else render();
    },
    "load-sample"() {
      const p = sampleProfile(me());
      if (commit(null, null, null, () => db.profiles.push(p))) { ui.profileId = p.id; ui.tab = "schedule"; render(); toast("Sample loaded. Try signing in as maria@example.com to see the aide's view."); }
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
    async "open-doc"(el, p) {
      const d = p.docs.find((x) => x.id === el.dataset.id);
      const w = window.open("", "_blank");
      try {
        const blob = await idb.get(d.id);
        if (!blob) throw new Error();
        const url = URL.createObjectURL(blob);
        if (w) w.location = url; else location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch {
        if (w) w.close();
        toast("This file isn't stored in this browser.", true);
      }
    },
    "del-doc"(el, p) {
      const d = p.docs.find((x) => x.id === el.dataset.id);
      if (d && confirm(`Delete “${d.name}”?`) && commit(p, "notes", `Deleted upload “${d.name}”`, () => p.docs.splice(p.docs.indexOf(d), 1))) {
        idb.del(d.id).catch(() => {});
        render();
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
    "delete-profile"(el, p) {
      const typed = prompt(`This permanently deletes ${p.name}'s profile and every uploaded file. Type DELETE to confirm.`);
      if (typed !== "DELETE") return;
      if (!can(p, "deleteProfile")) return toast("Not deleted: only the owner can delete a profile.", true);
      const docIds = p.docs.map((d) => d.id);
      if (commit(null, null, null, () => db.profiles.splice(db.profiles.indexOf(p), 1))) {
        docIds.forEach((id) => idb.del(id).catch(() => {}));
        ui.profileId = null;
        render();
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
  // Another tab changed the data: reload it so this tab never overwrites newer entries.
  window.addEventListener("storage", (e) => { if (e.key === STORE_KEY) { db = load(); render(); } });

  if (justSubscribed && !isSubscribed()) ui.unlock = true;
  render();
  recheckSubscription();
  // Lock the app if the trial runs out while it is open.
  setInterval(() => { if (!isSubscribed() && trialDaysLeft() === 0 && !document.querySelector('[data-form="unlock"]')) render(); }, 60000);
})();
