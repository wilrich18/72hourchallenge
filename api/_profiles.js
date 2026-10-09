// Care profile storage and the server-side permission rules (PRD P2 and R5).
const L = require("./_lib");

const INVITE_DAYS = 7;
const SHARE_LINK_DAYS = 14;
const MAX_PROFILE_BYTES = 1500000;

// Matches the PRD's proposed permissions table.
const PERMS = {
  family: ["editProfile", "manageTeam", "editSchedule", "followups", "medical", "notes", "logs", "deleteProfile"],
  assisting: ["followups", "logs"],
  physician: ["followups", "medical", "notes", "logs"],
};
const can = (role, action) => !!role && PERMS[role].includes(action);

// Which permission each part of a profile needs to change.
const SECTIONS = [
  { keys: ["name", "dob", "summary", "emergency"], perm: "editProfile", label: "profile details" },
  { keys: ["team"], perm: "manageTeam", label: "the care team" },
  { keys: ["shifts"], perm: "editSchedule", label: "the schedule" },
  { keys: ["followups"], perm: "followups", label: "follow-ups" },
  { keys: ["diagnoses", "meds", "medical"], perm: "medical", label: "medical history" },
  { keys: ["notes", "docs"], perm: "notes", label: "doctor's notes" },
  { keys: ["logs"], perm: "logs", label: "logs" },
];
const AUTHORED = ["followups", "diagnoses", "meds", "notes", "docs", "logs"];
const ARRAYS = ["team", "shifts", "followups", "diagnoses", "meds", "notes", "docs", "logs"];

const profilePath = (id) => `profiles/${id}.json`;
const accessPath = (email) => `access/${L.sha256(email)}.json`;
const validId = (id) => typeof id === "string" && /^[a-z0-9]{6,40}$/.test(id);

async function getProfile(id) { return validId(id) ? L.readJson(profilePath(id)) : null; }

async function addAccess(email, id) {
  const cur = await L.readJson(accessPath(email));
  const ids = cur?.data?.ids || [];
  if (!ids.includes(id)) await L.writeJson(accessPath(email), { ids: [...ids, id] });
}
async function accessIds(email) { return (await L.readJson(accessPath(email)))?.data?.ids || []; }

function member(profile, email) {
  return (profile.team || []).find((m) => m.email && m.email === email && (m.status === "owner" || m.status === "joined"));
}
const roleOf = (profile, email) => member(profile, email)?.role || null;

// What the browser gets: share link tokens are never sent back, only their details.
function view(profile) {
  return {
    ...profile,
    shareLinks: (profile.shareLinks || []).map(({ id, role, createdAt, expiresAt, createdByName }) => ({ id, role, createdAt, expiresAt, createdByName })),
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const stamp = (user, role) => ({ byName: user.name, byEmail: user.email, byRole: role, at: new Date().toISOString() });

// Applies a change sent by the browser to the stored profile, refusing anything the
// person's role doesn't allow. Returns { profile, invited, removedDocs } or { error }.
function applyChange(old, incoming, user, role) {
  if (!incoming || typeof incoming !== "object") return { error: "Invalid profile." };
  const next = { ...old };

  for (const section of SECTIONS) {
    const changed = section.keys.some((k) => !same(old[k], incoming[k]));
    if (!changed) continue;
    if (!can(role, section.perm)) return { error: `Your role can't change ${section.label}.`, status: 403 };
    for (const k of section.keys) next[k] = incoming[k];
  }

  for (const k of ARRAYS) {
    if (!Array.isArray(next[k])) return { error: `Invalid ${k}.` };
    if (next[k].some((x) => !x || typeof x !== "object" || typeof x.id !== "string")) return { error: `Invalid ${k}.` };
  }
  if (typeof next.name !== "string" || !next.name.trim()) return { error: "The profile needs a name." };

  // New entries must be signed by the person saving them.
  for (const k of AUTHORED) {
    const before = new Set((old[k] || []).map((x) => x.id));
    for (const item of next[k]) {
      if (!before.has(item.id) && item.byEmail !== user.email) return { error: "New entries must be signed by you.", status: 403 };
    }
  }

  // Logs are a record: existing entries can't be edited or removed.
  const newLogIds = new Set(next.logs.map((x) => x.id));
  for (const log of old.logs || []) {
    const now = next.logs.find((x) => x.id === log.id);
    if (!newLogIds.has(log.id) || !same(now, log)) return { error: "Log entries can't be changed once saved.", status: 403 };
  }

  // Team rules: the owner stays, and new people can only be invited or added as contacts.
  const oldTeam = new Map((old.team || []).map((m) => [m.id, m]));
  const invited = [];
  for (const m of next.team) {
    const prev = oldTeam.get(m.id);
    if (prev && (prev.status === "owner" || prev.status === "joined") && !same(prev, m)) return { error: "People who have joined can only be removed, not changed.", status: 403 };
    if (!prev) {
      if (m.status === "invited") {
        const email = L.normEmail(m.email);
        if (!L.validEmail(email)) return { error: "Please enter a valid email for the invitation." };
        if (next.team.some((o) => o !== m && o.email === email && o.status !== "contact")) return { error: "That person is already on the care team." };
        Object.assign(m, { email, invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() });
        invited.push(m);
      } else if (m.status === "contact") {
        m.email = null;
      } else {
        return { error: "New people must be invited by email.", status: 403 };
      }
      if (!["family", "assisting", "physician"].includes(m.role)) return { error: "Invalid role." };
    }
  }
  if (!next.team.some((m) => m.status === "owner")) return { error: "The owner can't be removed.", status: 403 };

  // Uploaded files must live under this profile's folder.
  const prefix = `files/${old.id}/`;
  const oldDocs = new Set((old.docs || []).map((d) => d.pathname));
  for (const d of next.docs) {
    if (!oldDocs.has(d.pathname) && (typeof d.pathname !== "string" || !d.pathname.startsWith(prefix))) return { error: "Invalid upload." };
  }
  const keptDocs = new Set(next.docs.map((d) => d.pathname));
  const removedDocs = [...oldDocs].filter((p) => p && !keptDocs.has(p));

  // History is append-only: keep everything stored, add the new entries this person signed.
  const known = new Set((old.history || []).map((x) => x.id));
  const added = (Array.isArray(incoming.history) ? incoming.history : [])
    .filter((x) => x && typeof x.id === "string" && !known.has(x.id) && x.byEmail === user.email)
    .slice(0, 20)
    .map((x) => ({ id: x.id, text: String(x.text || "").slice(0, 300), ...stamp(user, role) }));
  next.history = [...added, ...(old.history || [])].slice(0, 2000);

  next.shareLinks = old.shareLinks || [];
  next.id = old.id;
  next.createdAt = old.createdAt;
  next.version = (old.version || 0) + 1;
  next.updatedAt = Date.now();
  if (JSON.stringify(next).length > MAX_PROFILE_BYTES) return { error: "This profile is too large to save." };
  return { profile: next, invited, removedDocs };
}

async function sendInvites(req, profile, invited, inviter) {
  for (const m of invited.slice(0, 5)) {
    await addAccess(m.email, profile.id);
    const mail = L.emailLayout(`${inviter.name} invited you to Care Loop`, [
      `${inviter.name} invited you to join the care team for ${profile.name} on Care Loop as a ${m.role === "physician" ? "physician" : m.role === "assisting" ? "assisting caregiver" : "family caregiver"}.`,
      `Create a free account or log in with this email address (${m.email}) to accept. The invitation expires in ${INVITE_DAYS} days.`,
    ], { label: "Open Care Loop", url: `${L.origin(req)}/app?login` });
    await L.sendEmail({ to: m.email, subject: `${inviter.name} invited you to help care for ${profile.name}`, ...mail }).catch(() => {});
  }
}

module.exports = {
  INVITE_DAYS, SHARE_LINK_DAYS, PERMS, can, validId, profilePath, getProfile, addAccess, accessIds,
  member, roleOf, view, applyChange, sendInvites, stamp,
};
