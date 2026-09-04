// DOM-level input primitives, used when the transport has no focus emulation
// (Playwright's real input needs a foreground/emulated-focus tab).
//
// These functions are stringified and evaluated inside the page, so they must be
// self-contained — no imports, no closures.
//
// Two things they deliberately re-implement, because losing them would make
// tests pass where a human cannot click:
//   * actionability: size, disabled, pointer-events, visibility, and a real
//     elementFromPoint hit test (reported as `obscured-by:<tag>.<class>`)
//   * reach: open shadow roots are pierced (document.querySelector cannot);
//     cross-document frames are handled by the caller, which retries the same
//     op in every frame.

/** Collect matches from the document AND every open shadow root. */
export const DEEP_QUERY_ALL = function deepQueryAll(root, selector, out) {
  out = out || [];
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
