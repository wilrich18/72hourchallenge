// Care profiles: /api/profiles
//   GET                         list the profiles this account can open
//   POST   ?action=create       create a profile (the caller becomes the owner)
//   POST   ?action=sample       create a sample profile to look around
//   PUT    ?id=…                save changes (checked against the caller's role)
//   DELETE ?id=…                delete a profile and its files (owner only)
//   POST   ?id=…&action=share-link       create a doctor link (owner only)
//   POST   ?id=…&action=revoke-link      revoke a doctor link (owner only)
//   POST   ?action=join         join a profile as its physician using a doctor link
const L = require("./_lib");
const P = require("./_profiles");
const sample = require("./_sample");

module.exports = async function handler(req, res) {
  L.noStore(res);
  try {
    const user = await L.currentUser(req);
    if (!user) return L.fail(res, 401, "Please log in first.");
    const status = await L.accountStatus(user);
    if (!status.access) return L.fail(res, 402, "Your free trial has ended. Subscribe to keep using Care Loop.");

    const action = req.query.action || "";
    const route = `${req.method} ${action}`;
    if (route === "GET ") return await list(req, res, user);
    if ((route === "POST create" || route === "POST sample") && !status.ownerAccess) {
      return L.fail(res, 402, "Creating your own care profiles needs a Care Loop subscription.");
    }
    if (route === "POST create") return await create(req, res, user, L.body(req).profile);
    if (route === "POST sample") return await create(req, res, user, sample(user), true);
    if (route === "POST join") return await join(req, res, user);

    const found = await P.getProfile(req.query.id);
    const role = found && P.roleOf(found.data, user.email);
    if (!role) return L.fail(res, 404, "Profile not found.");
    if (route === "PUT ") return await save(req, res, user, role, found);
    if (route === "DELETE ") return await remove(req, res, role, found);
    if (route === "POST share-link") return await shareLink(req, res, user, role, found);
    if (route === "POST revoke-link") return await revokeLink(req, res, user, role, found);
    return L.fail(res, 404, "Not found.");
  } catch (err) {
    console.error("profiles failed:", err.message);
    if (L.isConflict(err)) return L.fail(res, 409, "Someone else just changed this profile. Please try again.");
    return L.fail(res, 500, "Something went wrong on our side. Your change was not saved.");
  }
};

async function list(req, res, user) {
  const profiles = [];
  let pendingInvites = 0;
  for (const id of await P.accessIds(user.email)) {
    const found = await P.getProfile(id);
    if (!found) continue;
    const p = found.data;
    if (P.member(p, user.email)) { profiles.push(P.view(p)); continue; }
    const invite = p.team.find((m) => m.email === user.email && m.status === "invited");
    if (!invite || new Date(invite.expiresAt).getTime() < Date.now()) continue;
    // Only a confirmed email can accept an invitation, so nobody can claim someone else's.
    if (!user.verified) { pendingInvites++; continue; }
    invite.status = "joined";
    invite.name = user.name;
    p.history.unshift({ id: L.randomToken().slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "x"), text: `${user.name} accepted the invitation`, ...P.stamp(user, invite.role) });
    p.version = (p.version || 0) + 1;
    try {
      await L.writeJson(P.profilePath(p.id), p, { etag: found.etag });
      profiles.push(P.view(p));
    } catch (err) {
      if (!L.isConflict(err)) throw err; // someone saved at the same moment; accepted on next load
    }
  }
  return res.status(200).json({ profiles, pendingInvites });
}

async function create(req, res, user, incoming, isSample) {
  if (!incoming || !P.validId(incoming.id)) return L.fail(res, 400, "Invalid profile.");
  if (!isSample && !incoming.authority) return L.fail(res, 400, "Please confirm you have the authority to share this person's health information.");
  const owner = { id: incoming.id + "o", name: user.name, email: user.email, role: "family", status: "owner" };
  const empty = {
    id: incoming.id, name: "", dob: "", summary: "", emergency: { name: "", phone: "" },
    team: [owner], shifts: [], followups: [], diagnoses: [], meds: [], notes: [], docs: [], logs: [], history: [],
    medical: { allergies: "", mobility: "", needs: "", primary: "" }, shareLinks: [], version: 0, createdAt: Date.now(),
  };
  const draft = { ...empty, ...incoming, team: [owner, ...(incoming.team || []).filter((m) => m.status !== "owner")] };
  draft.history = [{ id: incoming.id + "c", text: isSample ? "Created the sample profile" : "Created the profile", byEmail: user.email }];
  const result = P.applyChange(empty, draft, user, "family");
  if (result.error) return L.fail(res, result.status || 400, result.error);
  try {
    await L.writeJson(P.profilePath(result.profile.id), result.profile, { create: true });
  } catch (err) {
    if (L.isConflict(err)) return L.fail(res, 409, "A profile with that ID already exists. Please try again.");
    throw err;
  }
  await P.addAccess(user.email, result.profile.id);
  await P.sendInvites(req, result.profile, result.invited, user);
  return res.status(201).json({ profile: P.view(result.profile) });
}

async function save(req, res, user, role, found) {
  const { profile: incoming, version } = L.body(req);
  if (version !== found.data.version) {
    return L.fail(res, 409, "Someone else changed this profile while you were editing. We've loaded the latest version.", { profile: P.view(found.data) });
  }
  const result = P.applyChange(found.data, incoming, user, role);
  if (result.error) return L.fail(res, result.status || 400, result.error, { profile: P.view(found.data) });
  try {
    await L.writeJson(P.profilePath(found.data.id), result.profile, { etag: found.etag });
  } catch (err) {
    if (!L.isConflict(err)) throw err;
    const latest = await P.getProfile(found.data.id);
    return L.fail(res, 409, "Someone else changed this profile while you were editing. We've loaded the latest version.", { profile: latest && P.view(latest.data) });
  }
  if (result.removedDocs.length) await L.del(result.removedDocs).catch((err) => console.error("file delete failed:", err.message));
  await P.sendInvites(req, result.profile, result.invited, user);
  return res.status(200).json({ profile: P.view(result.profile) });
}

async function remove(req, res, role, found) {
  if (!P.can(role, "deleteProfile")) return L.fail(res, 403, "Only the owner can delete a profile.");
  const files = (found.data.docs || []).map((d) => d.pathname).filter(Boolean);
  if (files.length) await L.del(files);
  await L.del(P.profilePath(found.data.id));
  return res.status(200).json({ ok: true });
}

async function shareLink(req, res, user, role, found) {
  if (!P.can(role, "manageTeam")) return L.fail(res, 403, "Only the owner can share this profile.");
  const p = found.data;
  const active = (p.shareLinks || []).filter((l) => new Date(l.expiresAt).getTime() > Date.now());
  if (active.length >= 10) return L.fail(res, 400, "You have 10 active doctor links. Revoke one before creating another.");
  const token = L.randomToken();
  const link = {
    id: L.sha256(token).slice(0, 12), tokenHash: L.sha256(token), role: "physician",
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + P.SHARE_LINK_DAYS * 86400000).toISOString(), createdByName: user.name,
  };
  p.shareLinks = [...active, link];
  p.history.unshift({ id: link.id + "s", text: "Created a doctor link", ...P.stamp(user, role) });
  p.version = (p.version || 0) + 1;
  await L.writeJson(P.profilePath(p.id), p, { etag: found.etag });
  return res.status(201).json({ url: `${L.origin(req)}/app?join=${token}&profile=${p.id}`, profile: P.view(p) });
}

async function revokeLink(req, res, user, role, found) {
  if (!P.can(role, "manageTeam")) return L.fail(res, 403, "Only the owner can revoke doctor links.");
  const p = found.data;
  const linkId = String(L.body(req).linkId || "");
  if (!(p.shareLinks || []).some((l) => l.id === linkId)) return L.fail(res, 404, "That link no longer exists.");
  p.shareLinks = p.shareLinks.filter((l) => l.id !== linkId);
  p.history.unshift({ id: linkId + "r", text: "Revoked a doctor link", ...P.stamp(user, role) });
  p.version = (p.version || 0) + 1;
  await L.writeJson(P.profilePath(p.id), p, { etag: found.etag });
  return res.status(200).json({ profile: P.view(p) });
}

async function join(req, res, user) {
  const { profileId, token } = L.body(req);
  if (!user.verified) return L.fail(res, 403, "Please confirm your email address first, then open the doctor link again.", { needsVerification: true });
  const found = await P.getProfile(profileId);
  const p = found?.data;
  const link = p && (p.shareLinks || []).find((l) => L.safeEqual(l.tokenHash, L.sha256(String(token || ""))));
  if (!link || new Date(link.expiresAt).getTime() < Date.now()) return L.fail(res, 404, "This doctor link has expired or was revoked. Ask the family caregiver for a new one.");
  if (!P.member(p, user.email)) {
    p.team = p.team.filter((m) => m.email !== user.email);
    p.team.push({ id: L.sha256(user.email + p.id).slice(0, 12), name: user.name, email: user.email, role: link.role, status: "joined", joinedVia: "doctor link" });
    p.history.unshift({ id: L.sha256(user.email + link.id).slice(0, 12), text: `${user.name} joined using a doctor link`, ...P.stamp(user, link.role) });
    p.version = (p.version || 0) + 1;
    await L.writeJson(P.profilePath(p.id), p, { etag: found.etag });
    await P.addAccess(user.email, p.id);
  }
  return res.status(200).json({ profile: P.view(p) });
}
