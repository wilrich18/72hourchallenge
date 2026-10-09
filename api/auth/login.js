const L = require("../_lib");

module.exports = async function handler(req, res) {
  if (!L.onlyMethod(req, res, "POST")) return;
  const { email: rawEmail, password } = L.body(req);
  const email = L.normEmail(rawEmail);
  const wrong = () => res.status(401).json({ error: "That email and password don't match an account." });
  if (!L.validEmail(email) || typeof password !== "string" || !password || password.length > 200) return wrong();

  try {
    const user = await L.getUser(email);
    if (!user || !L.checkPassword(password, user)) return wrong();
    L.setSession(res, email);
    return res.status(200).json(await L.accountStatus(user));
  } catch (err) {
    console.error("login failed:", err.message);
    return res.status(500).json({ error: "We couldn't log you in. Please try again." });
  }
};
