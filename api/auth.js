// Account endpoint: /api/auth?action=signup|login|logout|me|verify|resend-verification|forgot|reset
const L = require("./_lib");

const ACTIONS = {
  "POST signup": signup,
  "POST login": login,
  "POST logout": logout,
  "GET me": me,
  "GET verify": verify,
  "POST resend-verification": resendVerification,
  "POST forgot": forgot,
  "POST reset": reset,
};

module.exports = async function handler(req, res) {
  L.noStore(res);
  const fn = ACTIONS[`${req.method} ${req.query?.action}`];
  if (!fn) return L.fail(res, 404, "Not found.");
  try {
    return await fn(req, res);
  } catch (err) {
    console.error(`auth ${req.query.action} failed:`, err.message);
    return L.fail(res, 500, "Something went wrong on our side. Please try again.");
  }
};

async function sendVerification(req, user) {
  const token = L.randomToken();
  user.verifyTokenHash = L.sha256(token);
  user.verifyExpiresAt = Date.now() + L.VERIFY_TTL_MS;
  user.verifySentAt = Date.now();
  const url = `${L.origin(req)}/api/auth?action=verify&email=${encodeURIComponent(user.email)}&token=${token}`;
  const mail = L.emailLayout("Confirm your email", [`Hi ${user.name}, please confirm this is your email address for Care Loop. The link works for 48 hours.`], { label: "Confirm my email", url });
  return L.sendEmail({ to: user.email, subject: "Confirm your Care Loop email", ...mail });
}

async function signup(req, res) {
  const { name, email: rawEmail, password } = L.body(req);
  const email = L.normEmail(rawEmail);
  const cleanName = String(name || "").trim().slice(0, 80);
  if (!cleanName) return L.fail(res, 400, "Please enter your name.");
  if (!L.validEmail(email)) return L.fail(res, 400, "Please enter a valid email address.");
  const problem = L.passwordProblem(password);
  if (problem) return L.fail(res, 400, problem);

  const user = { name: cleanName, email, ...L.hashPassword(password), createdAt: Date.now(), trialStartedAt: Date.now(), verified: false, sessionVersion: 0 };
  try {
    await L.saveUser(user, { create: true });
  } catch (err) {
    if (L.isConflict(err)) return L.fail(res, 409, "An account with that email already exists. Try logging in.");
    throw err;
  }
  const emailSent = await sendVerification(req, user);
  await L.saveUser(user);
  L.setSession(res, user);
  return res.status(201).json({ ...(await L.accountStatus(user)), emailSent });
}

async function login(req, res) {
  const { email: rawEmail, password } = L.body(req);
  const email = L.normEmail(rawEmail);
  const wrong = () => L.fail(res, 401, "That email and password don't match an account.");
  if (!L.validEmail(email) || typeof password !== "string" || !password || password.length > 200) return wrong();

  const user = await L.getUser(email);
  if (!user) return wrong();
  const now = Date.now();
  if (user.lockedUntil > now) {
    const mins = Math.ceil((user.lockedUntil - now) / 60000);
    return L.fail(res, 429, `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or reset your password.`);
  }
  if (!L.checkPassword(password, user)) {
    const inWindow = user.failedLoginAt && now - user.failedLoginAt < L.LOGIN_WINDOW_MS;
    const failures = (inWindow ? user.failedLogins || 0 : 0) + 1;
    const locked = failures >= L.LOGIN_MAX_FAILURES;
    await L.saveUser({ ...user, failedLogins: locked ? 0 : failures, failedLoginAt: inWindow ? user.failedLoginAt : now, lockedUntil: locked ? now + L.LOGIN_WINDOW_MS : 0 });
    if (locked) return L.fail(res, 429, "Too many wrong passwords. Try again in 15 minutes, or reset your password.");
    return wrong();
  }
  if (user.failedLogins || user.lockedUntil) await L.saveUser({ ...user, failedLogins: 0, failedLoginAt: 0, lockedUntil: 0 });
  L.setSession(res, user);
  return res.status(200).json(await L.accountStatus(user));
}

function logout(req, res) {
  L.clearSession(res);
  return res.status(200).json({ ok: true });
}

async function me(req, res) {
  const user = await L.currentUser(req);
  if (!user) {
    L.clearSession(res);
    return L.fail(res, 401, "Not signed in.");
  }
  return res.status(200).json(await L.accountStatus(user, { refresh: req.query.refresh === "1" }));
}

// Opened from the email link; redirects back into the app with the result.
async function verify(req, res) {
  const email = L.normEmail(req.query.email);
  const token = String(req.query.token || "");
  const user = L.validEmail(email) && token ? await L.getUser(email) : null;
  let ok = !!user && user.verified;
  if (user && !user.verified && user.verifyExpiresAt > Date.now() && L.safeEqual(L.sha256(token), user.verifyTokenHash)) {
    await L.saveUser({ ...user, verified: true, verifyTokenHash: null, verifyExpiresAt: 0 });
    ok = true;
  }
  res.setHeader("Location", `/app?verified=${ok ? 1 : 0}`);
  return res.status(302).end();
}

async function resendVerification(req, res) {
  const user = await L.currentUser(req);
  if (!user) return L.fail(res, 401, "Please log in first.");
  if (user.verified) return res.status(200).json({ ok: true, alreadyVerified: true });
  if (user.verifySentAt && Date.now() - user.verifySentAt < L.EMAIL_RESEND_MS) {
    return L.fail(res, 429, "We just sent one. Please wait a minute before asking again.");
  }
  const sent = await sendVerification(req, user);
  await L.saveUser(user);
  if (!sent) return L.fail(res, 503, "We couldn't send the email right now. Please try again later.");
  return res.status(200).json({ ok: true });
}

// Always answers the same way, so it can't be used to find out who has an account.
async function forgot(req, res) {
  const email = L.normEmail(L.body(req).email);
  const generic = { ok: true, message: "If an account uses that email, we've sent a link to reset the password." };
  if (!L.validEmail(email)) return L.fail(res, 400, "Please enter a valid email address.");
  const user = await L.getUser(email);
  if (!user || (user.resetSentAt && Date.now() - user.resetSentAt < L.EMAIL_RESEND_MS)) return res.status(200).json(generic);

  const token = L.randomToken();
  const url = `${L.origin(req)}/app?reset=${token}&email=${encodeURIComponent(email)}`;
  const mail = L.emailLayout("Reset your password", [`Hi ${user.name}, someone asked to reset your Care Loop password. If it was you, use the button below. The link works for 1 hour.`, "If you didn't ask for this, you can ignore this email. Your password won't change."], { label: "Choose a new password", url });
  await L.saveUser({ ...user, resetTokenHash: L.sha256(token), resetExpiresAt: Date.now() + L.RESET_TTL_MS, resetSentAt: Date.now() });
  // Same answer even if sending fails, so the response never reveals whether the account exists.
  await L.sendEmail({ to: email, subject: "Reset your Care Loop password", ...mail });
  return res.status(200).json(generic);
}

async function reset(req, res) {
  const { email: rawEmail, token, password } = L.body(req);
  const email = L.normEmail(rawEmail);
  const user = L.validEmail(email) ? await L.getUser(email) : null;
  const valid = user && user.resetExpiresAt > Date.now() && L.safeEqual(L.sha256(String(token || "")), user.resetTokenHash);
  if (!valid) return L.fail(res, 400, "This reset link has expired or was already used. Please ask for a new one.");
  const problem = L.passwordProblem(password);
  if (problem) return L.fail(res, 400, problem);

  // A new password logs out every other device, and proves the person owns the email.
  const updated = {
    ...user, ...L.hashPassword(password), resetTokenHash: null, resetExpiresAt: 0,
    sessionVersion: (user.sessionVersion || 0) + 1, verified: true, failedLogins: 0, lockedUntil: 0,
  };
  await L.saveUser(updated);
  L.setSession(res, updated);
  return res.status(200).json(await L.accountStatus(updated));
}
