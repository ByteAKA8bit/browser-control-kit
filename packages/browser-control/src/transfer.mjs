// File upload and drag & drop for the DOM-input path.
//
// Normally CDP/OS-level (setInputFiles → DOM.setFileInputFiles; dragAndDrop
// moves the real mouse), unavailable with only a background tab (extension
// transport), so they are rebuilt from unprivileged web APIs:
//   files → new File(bytes) → DataTransfer → input.files + input/change events
//   drop  → the same DataTransfer delivered as dragenter/dragover/drop
//   drag  → HTML5 (dragstart/dragover/drop/dragend) AND pointer-event drags,
//           because dnd-kit / react-dnd style libraries listen to pointers,
//           not to the HTML5 drag API
//
// Stringified into the page, so: self-contained, no imports, no closures.

/** Build a FileList-compatible DataTransfer from [{name, type, base64}]. */
export const DOM_MAKE_TRANSFER = function makeTransfer(files) {
  const dt = new DataTransfer();
  for (const f of files) {
    const binary = atob(f.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream", lastModified: Date.now() }));
  }
  return dt;
};

export const DOM_SET_FILES = (selector, files, deepSrc, transferSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const makeTransfer = new Function(`return ${transferSrc}`)();
  const el = deep(document, selector)[0];
  if (!el) return { ok: false, reason: "not-found" };
  if (el.tagName !== "INPUT" || el.type !== "file") return { ok: false, reason: `not-a-file-input:${el.tagName}/${el.type}` };
  if (el.disabled) return { ok: false, reason: "disabled" };
  if (files.length > 1 && !el.multiple) return { ok: false, reason: "input-not-multiple" };
  if (el.accept) {
    // Mirror the browser's own filter so a wrong fixture fails loudly here
    // instead of silently uploading something the UI would never allow.
    const accepts = el.accept.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
    for (const f of files) {
      const name = f.name.toLowerCase();
      const type = (f.type || "").toLowerCase();
      const ok = accepts.some((a) =>
        a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a,
      );
      if (!ok) return { ok: false, reason: `rejected-by-accept:${el.accept}` };
    }
  }
  const dt = makeTransfer(files);
  el.files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, count: el.files.length, names: [...el.files].map((f) => f.name) };
};

export const DOM_DROP_FILES = (selector, files, deepSrc, transferSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const makeTransfer = new Function(`return ${transferSrc}`)();
  const el = deep(document, selector)[0];
  if (!el) return { ok: false, reason: "not-found" };
  const dt = makeTransfer(files);
  const rect = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  for (const type of ["dragenter", "dragover"]) el.dispatchEvent(new DragEvent(type, { ...base, dataTransfer: dt }));
  el.dispatchEvent(new DragEvent("drop", { ...base, dataTransfer: dt }));
  return { ok: true, count: dt.files.length };
};

// Arg order matches the caller, which always appends deepSrc last.
export const DOM_DRAG = (fromSelector, toSelector, steps, deepSrc) => {
  const deep = new Function(`return ${deepSrc}`)();
  const from = deep(document, fromSelector)[0];
  const to = deep(document, toSelector)[0];
  if (!from) return { ok: false, reason: "from-not-found" };
  if (!to) return { ok: false, reason: "to-not-found" };
  from.scrollIntoView({ block: "center" });
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const pointer = (type, x, y, extra) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: "mouse", ...extra });
  const mouse = (type, x, y) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 });

  // 1) pointer-based drag (dnd-kit, react-dnd, sortable.js …)
  from.dispatchEvent(pointer("pointerdown", start.x, start.y));
  from.dispatchEvent(mouse("mousedown", start.x, start.y));
  const n = Math.max(2, steps ?? 8);
  for (let i = 1; i <= n; i += 1) {
    const x = start.x + ((end.x - start.x) * i) / n;
    const y = start.y + ((end.y - start.y) * i) / n;
    const target = document.elementFromPoint(x, y) ?? to;
    target.dispatchEvent(pointer("pointermove", x, y));
    target.dispatchEvent(mouse("mousemove", x, y));
  }
  to.dispatchEvent(pointer("pointerup", end.x, end.y));
  to.dispatchEvent(mouse("mouseup", end.x, end.y));

  // 2) HTML5 drag API, for elements that opted into draggable=true
  if (from.draggable) {
    const dt = new DataTransfer();
    const drag = (type, el, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
    drag("dragstart", from, start.x, start.y);
    drag("dragenter", to, end.x, end.y);
    drag("dragover", to, end.x, end.y);
    drag("drop", to, end.x, end.y);
    drag("dragend", from, end.x, end.y);
  }
  return { ok: true, from: start, to: end, html5: !!from.draggable };
};
