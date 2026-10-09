/* Care Loop language switcher.
 * Pages are written in English. When another language is picked, visible interface text is
 * translated through /api/ai?action=translate and cached in this browser. Anything inside
 * an element with translate="no" (names, medications, notes people typed) is left as written.
 */
(() => {
  "use strict";

  const LANGS = [
    ["en", "English"], ["es", "Español"], ["zh-CN", "中文（简体）"], ["zh-TW", "中文（繁體）"], ["hi", "हिन्दी"],
    ["ar", "العربية"], ["pt", "Português"], ["bn", "বাংলা"], ["ru", "Русский"], ["ja", "日本語"],
    ["fr", "Français"], ["de", "Deutsch"], ["ko", "한국어"], ["vi", "Tiếng Việt"], ["it", "Italiano"],
    ["tr", "Türkçe"], ["pl", "Polski"], ["uk", "Українська"], ["tl", "Tagalog"], ["ur", "اردو"],
    ["fa", "فارسی"], ["id", "Bahasa Indonesia"], ["th", "ไทย"], ["sw", "Kiswahili"], ["he", "עברית"],
    ["nl", "Nederlands"], ["el", "Ελληνικά"], ["ht", "Kreyòl ayisyen"], ["pa", "ਪੰਜਾਬੀ"], ["ta", "தமிழ்"], ["ro", "Română"],
  ];
  const RTL = new Set(["ar", "he", "fa", "ur"]);
  const PREF_KEY = "careloop-lang";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } },
  };

  let lang = store.get(PREF_KEY) || "en";
  if (!LANGS.some(([code]) => code === lang)) lang = "en";
  const cacheKey = `careloop-i18n-${lang}`;
  let cache = {};
  try { cache = JSON.parse(store.get(cacheKey) || "{}"); } catch { cache = {}; }

  window.CareLoopI18n = { lang, locale: lang === "en" ? undefined : lang };
  document.documentElement.lang = lang;
  if (RTL.has(lang)) document.documentElement.dir = "rtl";

  // ---------- language picker ----------
  function mountPicker() {
    for (const slot of document.querySelectorAll("[data-lang-picker]")) {
      if (slot.querySelector("select")) continue;
      slot.innerHTML = `<label class="sr-only" for="lang-select-${slot.dataset.langPicker}">Language</label>
        <select id="lang-select-${slot.dataset.langPicker}" class="lang-select" translate="no" title="Language">
          ${LANGS.map(([code, name]) => `<option value="${code}" ${code === lang ? "selected" : ""}>🌐 ${name}</option>`).join("")}
        </select>`;
      slot.querySelector("select").addEventListener("change", (e) => {
        store.set(PREF_KEY, e.target.value);
        location.reload();
      });
    }
  }

  if (lang === "en") {
    document.addEventListener("DOMContentLoaded", mountPicker);
    return;
  }

  // ---------- translating the page ----------
  const original = new WeakMap(); // text node or element -> English it was rendered with
  const pending = new Set();
  let applying = false;
  let timer = null;

  const translatable = (s) => /\p{L}{2,}/u.test(s) && s.length <= 400;
  const skip = (el) => !el || el.closest('[translate="no"], script, style, noscript, textarea, code');

  function textOf(node) {
    const raw = node.nodeValue;
    const text = raw.trim();
    return { raw, text, lead: raw.slice(0, raw.indexOf(text)), tail: raw.slice(raw.indexOf(text) + text.length) };
  }

  function translateNode(node) {
    const { text, lead, tail } = textOf(node);
    if (!text || !translatable(text)) return;
    const known = original.get(node);
    if (known && cache[known] === text) return; // already translated
    const source = known && node.nodeValue.trim() === cache[known] ? known : text;
    original.set(node, source);
    if (source in cache) node.nodeValue = lead + cache[source] + tail;
    else pending.add(source);
  }

  function translateAttrs(el) {
    for (const attr of ["placeholder", "aria-label", "title"]) {
      const v = el.getAttribute(attr);
      if (!v || !translatable(v)) continue;
      if (v in cache) el.setAttribute(attr, cache[v]);
      else if (!Object.values(cache).includes(v)) pending.add(v);
    }
  }

  function walk(root) {
    applying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) {
        if (!skip(root.parentElement)) translateNode(root);
      } else if (root.nodeType === Node.ELEMENT_NODE && !skip(root)) {
        const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let n = root; n; n = it.nextNode()) {
          if (n.nodeType === Node.ELEMENT_NODE) { if (!skip(n)) translateAttrs(n); }
          else if (!skip(n.parentElement)) translateNode(n);
        }
      }
    } finally {
      applying = false;
    }
    if (pending.size) { clearTimeout(timer); timer = setTimeout(flush, 60); }
  }

  async function flush() {
    const batch = [...pending].slice(0, 80);
    batch.forEach((s) => pending.delete(s));
    if (!batch.length) return;
    document.documentElement.classList.add("i18n-loading");
    try {
      const r = await fetch("/api/ai?action=translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang, strings: batch }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const { translations } = await r.json();
      Object.assign(cache, translations);
      const keys = Object.keys(cache);
      if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach((k) => delete cache[k]);
      store.set(cacheKey, JSON.stringify(cache));
      walk(document.body);
    } catch {
      // Translation unavailable: the page stays readable in English.
    } finally {
      document.documentElement.classList.remove("i18n-loading");
      if (pending.size) { clearTimeout(timer); timer = setTimeout(flush, 60); }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    mountPicker();
    walk(document.body);
    new MutationObserver((records) => {
      if (applying) return;
      for (const r of records) {
        if (r.type === "characterData") walk(r.target);
        else r.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
