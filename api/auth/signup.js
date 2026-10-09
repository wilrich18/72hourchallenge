const L = require("../_lib");

module.exports = async function handler(req, res) {
  if (!L.onlyMethod(req, res, "POST")) return;
  const { name, email: rawEmail, password } = L.body(req);
  const email = L.normEmail(rawEmail);
  const cleanName = String(name || "").trim().slice(0, 80);
  if (!cleanName) return res.status(400).json({ error: "Please enter your name." });
  if (!L.validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (typeof password !== "string" || password.length < L.MIN_PASSWORD) {
    return res.status(400).json({ error: `Please choose a password of at least ${L.MIN_PASSWORD} characters.` });
  }
  if (password.length > 200) return res.status(400).json({ error: "That password is too long." });

  try {
    const user = { name: cleanName, email, ...L.hashPassword(password), createdAt: Date.now(), trialStartedAt: Date.now() };
    try {
      await L.saveUser(user, { create: true });
    } catch (err) {
      if (/already exists|BlobPreconditionFailed/i.test(err.message + err.name)) {
        return res.status(409).json({ error: "An account with that email already exists. Try logging in." });
      }
      throw err;
    }
    L.setSession(res, email);
    return res.status(201).json(await L.accountStatus(user));
  } catch (err) {
    console.error("signup failed:", err.message);
    return res.status(500).json({ error: "We couldn't create your account. Please try again." });
  }
};
