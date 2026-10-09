// A sample profile for looking around. Every entry is signed by the account creating it,
// with the byline showing the sample care team member it represents.
const crypto = require("crypto");

const uid = () => crypto.randomBytes(9).toString("hex");

module.exports = function sampleProfile(user) {
  const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
  const at = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
  const by = (byName, byRole) => ({ byName, byEmail: user.email, byRole });
  const fam = by(user.name, "family");
  const aide = by("Maria Lopez (sample)", "assisting");
  const doc = by("Dr. Ada Okafor (sample)", "physician");
  const dx1 = uid(), dx2 = uid();
  return {
    id: uid(), name: "Eleanor Hughes (sample)", dob: "1941-03-12",
    summary: "Lives at home with her daughter. Hard of hearing on the left side, so speak on her right. Likes a short walk after lunch.",
    emergency: { name: user.name, phone: "5551234567" },
    team: [
      { id: uid(), name: "Maria Lopez", email: null, phone: "5552223333", role: "assisting", status: "contact" },
      { id: uid(), name: "Dr. Ada Okafor", email: null, phone: "5554445555", role: "physician", status: "contact" },
      { id: uid(), name: "Sam Hughes", email: null, phone: "5559876543", role: "family", status: "contact" },
    ],
    shifts: [
      { id: uid(), day: "Monday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
      { id: uid(), day: "Wednesday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
      { id: uid(), day: "Friday", start: "09:00", end: "13:00", caregiver: "Maria Lopez" },
      { id: uid(), day: "Saturday", start: "10:00", end: "16:00", caregiver: "Sam Hughes" },
      { id: uid(), day: "Sunday", start: "10:00", end: "16:00", caregiver: user.name },
    ],
    followups: [
      { id: uid(), kind: "pickup", what: "Pick up lisinopril refill", who: "Sam Hughes", date: day(-2), done: false, ...fam, at: at(-6) },
      { id: uid(), kind: "appointment", what: "Blood pressure recheck with Dr. Okafor", who: user.name, date: day(12), done: false, ...doc, at: at(-3) },
      { id: uid(), kind: "appointment", what: "Physical therapy evaluation", who: user.name, date: day(-9), done: true, ...fam, at: at(-20) },
    ],
    diagnoses: [
      { id: dx1, name: "High blood pressure", date: "2019-06-04", clinician: "Dr. Ada Okafor", notes: "Managed with medication.", status: "active", ...doc, at: at(-30) },
      { id: dx2, name: "Urinary tract infection", date: day(-40), clinician: "Urgent care", notes: "Finished antibiotics.", status: "resolved", ...fam, at: at(-40) },
    ],
    meds: [
      { id: uid(), name: "Lisinopril", dose: "20 mg", timing: "Every morning", prescriber: "Dr. Ada Okafor", ...doc, at: at(-3) },
      { id: uid(), name: "Vitamin D", dose: "1000 IU", timing: "With breakfast", prescriber: "", ...fam, at: at(-30) },
    ],
    medical: { allergies: "Penicillin (rash)", mobility: "Walks with a walker. Needs a hand on stairs.", needs: "Help with showering. Reminders for afternoon fluids.", primary: "Dr. Ada Okafor" },
    notes: [
      { id: uid(), date: day(-3), doctor: "Dr. Ada Okafor", dx: dx1, text: "Blood pressure still high at 152/90. Increasing lisinopril from 10 mg to 20 mg each morning. Recheck in 2 weeks. Please log any dizziness.", ...doc, at: at(-3) },
    ],
    docs: [],
    logs: [
      { id: uid(), note: "Took morning meds with breakfast. Walked to the mailbox and back with the walker. In good spirits.", date: day(-1), time: "10:15", ...aide, at: at(-1) },
      { id: uid(), note: "A little dizzy standing up after lunch. Sat for five minutes and it passed. Noting for Dr. Okafor.", date: day(-1), time: "13:20", ...aide, at: at(-1) },
      { id: uid(), note: "Quiet evening. Ate most of dinner.", date: day(-2), time: "19:00", ...fam, at: at(-2) },
    ],
  };
};
