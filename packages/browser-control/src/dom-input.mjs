// DOM-level input primitives, used when the transport has no focus emulation
// (Playwright's real input needs a foreground/emulated-focus tab).
//
// Stringified and evaluated inside the page: self-contained, no imports, no
// closures. `deepSrc` is always the last argument.
//
// Deliberately re-implemented, because losing them makes tests pass where a
// human cannot click:
//   * actionability: size, disabled, pointer-events, visibility, and a real
//     elementFromPoint hit test (reported as `obscured-by:<TAG>.<class>`)
//   * reach: open shadow roots are pierced (document.querySelector cannot);
//     cross-document frames are retried op-by-op by the caller.

/**
 * Collect matches from the document AND every open shadow root.
 * Also resolves `text=…` (Playwright's text engine) and `@n` (a ref from
 * DOM_SNAPSHOT), so every primitive speaks the same three dialects.
 */
export const DEEP_QUERY_ALL = function deepQueryAll(root, selector, out) {
  out = out || [];
  if (typeof selector === "string" && selector[0] === "@") {
    const el = window.__bcRefs?.[Number(selector.slice(1))];
    return el ? [el] : [];
  }
  if (typeof selector === "string" && selector.slice(0, 5) === "text=") {
    const raw = selector.slice(5);
    const exact = raw.length > 1 && raw[0] === '"' && raw[raw.length - 1] === '"';
    const needle = (exact ? raw.slice(1, -1) : raw).trim();
    const hits = deepQueryAll(root, "*", []).filter((el) => {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) return false;
      const body = (el.innerText || "").trim();
      return exact ? body === needle : body.toLowerCase().includes(needle.toLowerCase());
    });
    // The smallest match: an ancestor that contains another hit is not the target.
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  }
  try {
    for (const el of root.querySelectorAll(selector)) out.push(el);
  } catch {
    return out;
  }
  const walker = root.querySelectorAll("*");
  for (const el of walker) if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
  return out;
};

export const DOM_CLICK = (selector, index, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const el = deep(document, selector)[index ?? 0];
  if (!el) return { ok: false, reason: "not-found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { ok: false, reason: "zero-size" };
  if (el.disabled) return { ok: false, reason: "disabled" };
  const style = getComputedStyle(el);
  if (style.pointerEvents === "none") return { ok: false, reason: "pointer-events-none" };
  if (style.visibility === "hidden" || style.display === "none") return { ok: false, reason: "hidden" };
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Hit test like a real click: only the TOPMOST element at that point counts.
  // (Checking the whole stack would happily "click" through an overlay.)
  // elementsFromPoint sees the composed tree, so a shadow host may legitimately
  // sit on top of its own shadow content.
  const stack = document.elementsFromPoint(x, y);
  const top = stack[0];
  const root = el.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : null;
  const reachable = !!top && (top === el || el.contains(top) || (host && (top === host || host.contains(top))));
  if (!reachable) {
    const label = top ? top.tagName + (top.className ? "." + String(top.className).split(" ")[0] : "") : "nothing";
    return { ok: false, reason: `obscured-by:${label}` };
  }
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", base));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  if (typeof el.focus === "function") el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", base));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
  return { ok: true };
};

export const DOM_SET_VALUE = (selector, value, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const el = deep(document, selector)[0];
  if (!el) return { ok: false, reason: "not-found" };
  if (el.disabled) return { ok: false, reason: "disabled" };
  if (el.readOnly) return { ok: false, reason: "readonly" };
  if (el.tagName === "SELECT") {
    const option = [...el.options].find((o) => o.value === value || (o.textContent || "").trim() === value);
    if (!option) return { ok: false, reason: `no-option:${value}` };
    if (typeof el.focus === "function") el.focus();
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: el.value };
  }
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  if (!setter) return { ok: false, reason: `not-a-field:${el.tagName}` };
  if (typeof el.focus === "function") el.focus();
  setter.call(el, value);
  // React/Ant Design controlled inputs only react to these two.
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value };
};

export const DOM_KEY = (selector, key, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const el = selector ? deep(document, selector)[0] : document.activeElement;
  if (!el) return { ok: false, reason: "not-found" };
  const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (key === "Enter" && typeof el.form?.requestSubmit === "function") el.form.requestSubmit();
  return { ok: true };
};

export const DOM_READ_VALUE = (selector, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const el = deep(document, selector)[0];
  return el ? { ok: true, value: el.value ?? "" } : { ok: false, reason: "not-found" };
};

export const DOM_COUNT = (selector, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  return { ok: true, count: deep(document, selector).length };
};

export const DOM_TEXT = (selector, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const el = selector ? deep(document, selector)[0] : document.body;
  return el ? { ok: true, value: el.innerText ?? "" } : { ok: false, reason: "not-found" };
};

/**
 * The page as the agent should see it: every visible, actionable element with
 * a role, an accessible name, its state, and a stable ref (`@n` in this frame).
 * Refs live in `window.__bcRefs` and are valid until the next snapshot or
 * navigation; the caller prefixes them with the frame index (`f0:3`).
 */
export const DOM_SNAPSHOT = (max, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  max = Number(max) > 0 ? Number(max) : 200;
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const labelOf = (el) => {
    if (el.labels?.length) return clean(el.labels[0].innerText || el.labels[0].textContent);
    const ids = (el.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return "";
    const root = el.getRootNode();
    return clean(ids.split(/\s+/).map((id) => root.getElementById?.(id)?.innerText ?? document.getElementById(id)?.innerText ?? "").join(" "));
  };
  const roleOf = (el, tag, type) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return "generic";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "file") return "file";
    if (type === "search") return "searchbox";
    return "textbox";
  };
  const nameOf = (el, tag, type) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labelled = labelOf(el);
    if (labelled) return labelled;
    if (tag === "select" && el.selectedOptions?.[0]) return clean(el.selectedOptions[0].textContent);
    const hint = clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("alt"));
    if (hint) return hint;
    if (tag === "input" && ["button", "submit", "reset"].includes(type)) return clean(el.value);
    return clean(el.innerText || el.textContent);
  };
  const refs = [];
  const items = [];
  let truncated = false;
  for (const el of deep(document, "*")) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) continue;
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    const role = roleOf(el, tag, type);
    const actionable =
      (tag === "a" && el.hasAttribute("href")) ||
      tag === "button" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "summary" ||
      (tag === "input" && type !== "hidden") ||
      el.isContentEditable ||
      el.hasAttribute("onclick") ||
      (role !== "generic" && !["none", "presentation"].includes(role));
    if (!actionable) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (items.length >= max) {
      truncated = true;
      break;
    }
    const item = { ref: refs.length, role, tag, name: nameOf(el, tag, type) };
    if (type) item.type = type;
    const value = tag === "input" || tag === "textarea" || tag === "select" ? clean(el.value) : "";
    if (value) item.value = type === "password" ? "•••" : value;
    // Where a link goes: the agent can hand this straight to browser_download.
    if (tag === "a" && el.href) item.href = el.href;
    const state = [];
    if (el.disabled) state.push("disabled");
    if (el.checked) state.push("checked");
    if (el.selected) state.push("selected");
    if (el.readOnly) state.push("readonly");
    if (el.required) state.push("required");
    if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
    if (state.length) item.state = state;
    refs.push(el);
    items.push(item);
  }
  window.__bcRefs = refs;
  return { ok: true, items, truncated };
};
