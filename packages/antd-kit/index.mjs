// antd-kit — Ant Design v6 interaction helpers.
//
// App-agnostic: anything here is true for any antd v6 app, not just TalentFlow.
// Two traps this version sets, both handled:
//   1. modal bodies live in `.ant-modal-container` (v5's `.ant-modal-content`
//      does not exist)
//   2. closed modals stay mounted — only `.ant-modal-wrap` is hidden — so naive
//      selectors keep hitting the previous, invisible dialog. Every helper first
//      tags the VISIBLE dialog with data-qa-modal="active" and works inside it.
//
// `page` is expected to be a browser-control page (puppeteer-flavoured):
// multi-arg evaluate, waitForSelector({ visible }).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MODAL = '[data-qa-modal="active"]';

/** Tag the visible modal; returns false when no modal is on screen. */
export async function syncModal(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-qa-modal="active"]')) el.removeAttribute("data-qa-modal");
    const wrap = [...document.querySelectorAll(".ant-modal-wrap")].find(
      (w) => getComputedStyle(w).display !== "none" && w.querySelector(".ant-modal-container"),
    );
    if (!wrap) return false;
    wrap.querySelector(".ant-modal-container").setAttribute("data-qa-modal", "active");
    return true;
  });
}

export async function modalOpen(page) {
  return syncModal(page);
}

export async function modalTitle(page) {
  if (!(await syncModal(page))) return null;
  return page.evaluate((sel) => document.querySelector(`${sel} .ant-modal-title`)?.innerText?.trim() ?? null, MODAL);
}

// Drawers are the other overlay antd apps put forms in (Drawer instead of
// Modal). Same trap as modals: closed drawers stay mounted, so the OPEN one is
// tagged and every helper works inside that tag.
export const DRAWER = '[data-qa-drawer="active"]';

/** Tag the open drawer; returns false when none is on screen. */
export async function syncDrawer(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-qa-drawer="active"]')) el.removeAttribute("data-qa-drawer");
    const open = [...document.querySelectorAll(".ant-drawer")].find(
      (d) => d.classList.contains("ant-drawer-open") && d.querySelector(".ant-drawer-body"),
    );
    if (!open) return false;
    open.setAttribute("data-qa-drawer", "active");
    return true;
  });
}

export async function drawerOpen(page) {
  return syncDrawer(page);
}

export async function drawerTitle(page) {
  if (!(await syncDrawer(page))) return null;
  return page.evaluate((sel) => document.querySelector(`${sel} .ant-drawer-title`)?.innerText?.trim() ?? null, DRAWER);
}

/** Re-tag whichever overlay a helper was asked to work in. */
export async function syncScope(page, scope) {
  if (scope === MODAL) return syncModal(page);
  if (scope === DRAWER) return syncDrawer(page);
  return true;
}

/**
 * Click an enabled button by visible text.
 * EXACT text wins over substring: this screen has both「一時保存」and
 *「一時保存を破棄」, and a substring match would hit the destructive one first.
 */
export async function clickButton(page, text, { scope = "body", nth = 0 } = {}) {
  await syncScope(page, scope);
  const clicked = await page.evaluate(
    (t, s, n) => {
      const root = document.querySelector(s) ?? document.body;
      const norm = (v) => (v ?? "").replace(/\s+/g, "");
      const want = norm(t);
      const buttons = [...root.querySelectorAll("button")].filter((b) => !b.disabled);
      const exact = buttons.filter((b) => norm(b.innerText) === want);
      const partial = buttons.filter((b) => norm(b.innerText).includes(want));
      const hits = exact.length ? exact : partial;
      if (!hits[n]) return false;
      hits[n].click();
      return true;
    },
    text,
    scope,
    nth,
  );
  if (!clicked) throw new Error(`clickButton: no enabled button matching "${text}" in ${scope}`);
  await sleep(400);
  return true;
}

/** Click an icon-only button (antd icon name: plus / edit / delete / …). */
export async function clickIcon(page, icon, { scope = ".ant-tabs-tabpane-active", nth = 0 } = {}) {
  await syncScope(page, scope);
  const clicked = await page.evaluate(
    (ic, s, n) => {
      const root = document.querySelector(s) ?? document.body;
      const hits = [...root.querySelectorAll("button")].filter((b) => b.innerHTML.includes(`anticon-${ic}`) && !b.disabled);
      if (!hits[n]) return false;
      hits[n].click();
      return true;
    },
    icon,
    scope,
    nth,
  );
  if (!clicked) throw new Error(`clickIcon: no anticon-${icon} button in ${scope}`);
  await sleep(600);
  return true;
}

/** Validation messages inside the visible modal (or any scope). */
export async function formErrors(page, scope = "body") {
  await syncScope(page, scope);
  return page.evaluate((s) => {
    const root = document.querySelector(s) ?? document.body;
    return [...root.querySelectorAll(".ant-form-item-explain-error")].map((e) => e.innerText.trim());
  }, scope);
}

/** Set a controlled input's value inside the visible modal/drawer (React-safe). */
export async function setModalInput(page, selector, value, { scope = MODAL } = {}) {
  if (!(await syncScope(page, scope))) throw new Error(`setModalInput: no visible ${scope}`);
  const ok = await page.evaluate(
    (root, sel, val) => {
      const el = document.querySelector(`${root} ${sel}`);
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    scope,
    selector,
    value,
  );
  if (!ok) throw new Error(`setModalInput: ${selector} not found in ${scope}`);
  await sleep(250);
  return true;
}

/** Pick a radio / checkbox by its visible label inside a modal or drawer. */
export async function pickRadio(page, label, { scope = MODAL } = {}) {
  if (!(await syncScope(page, scope))) throw new Error(`pickRadio: no visible ${scope}`);
  const ok = await page.evaluate(
    (root, want) => {
      const el = document.querySelector(root);
      const wrappers = [...(el?.querySelectorAll(".ant-radio-button-wrapper, .ant-radio-wrapper, .ant-checkbox-wrapper") ?? [])];
      const hit = wrappers.find((w) => (w.innerText ?? "").trim() === want) ?? wrappers.find((w) => (w.innerText ?? "").includes(want));
      if (!hit) return false;
      (hit.querySelector("input") ?? hit).click();
      return true;
    },
    scope,
    label,
  );
  if (!ok) throw new Error(`pickRadio: "${label}" not found in ${scope}`);
  await sleep(250);
  return true;
}

/**
 * Antd Select inside a modal/drawer: open by input id, pick option text.
 * The real click is tried first (it is what a user does); when the transport's
 * hit test refuses — antd keeps closed overlays mounted, so the input can be
 * zero-size or reported as obscured — the dropdown is opened with DOM-level
 * mouse events on the `.ant-select` wrapper, which is what antd listens to.
 */
export async function selectOption(page, inputId, optionText, { scope = MODAL } = {}) {
  await syncScope(page, scope);
  const openViaDom = () =>
    page.evaluate(
      (root, id) => {
        const el = document.querySelector(`${root} #${id}`) ?? document.querySelector(`#${id}`);
        const wrapper = el?.closest(".ant-select");
        if (!wrapper) return false;
        for (const type of ["mousedown", "mouseup", "click"]) wrapper.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        return true;
      },
      scope,
      inputId,
    );
  const dropdownOpen = () =>
    page
      .waitForSelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { timeout: 4000 })
      .then(() => true)
      .catch(() => false);

  await page.click(`${scope} #${inputId}`).catch(async () => {
    await page.click(`#${inputId}`).catch(() => {});
  });
  if (!(await dropdownOpen())) {
    if (!(await openViaDom())) throw new Error(`selectOption(${inputId}): select not found in ${scope}`);
    if (!(await dropdownOpen())) throw new Error(`selectOption(${inputId}): dropdown did not open`);
  }
  const picked = await page.evaluate((t) => {
    const opts = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")];
    const hit = opts.find((o) => (o.innerText ?? "").trim() === t) ?? opts.find((o) => (o.innerText ?? "").includes(t));
    if (!hit) return { ok: false, options: opts.map((o) => o.innerText.trim()).slice(0, 30) };
    for (const type of ["mousedown", "mouseup", "click"]) hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  }, optionText);
  if (!picked.ok) throw new Error(`selectOption(${inputId}): "${optionText}" not found; options=${JSON.stringify(picked.options)}`);
  await sleep(350);
  return true;
}

/** Antd DatePicker inside a modal/drawer: type value, commit with Enter. */
export async function pickDate(page, inputId, value, { scope = MODAL } = {}) {
  await syncScope(page, scope);
  const sel = `${scope} #${inputId}`;
  await page.click(sel);
  await page.$eval(sel, (el) => {
    el.value = "";
  });
  await page.type(sel, value, { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(500);
  return page.$eval(sel, (el) => el.value);
}

/** Click 保存 in the visible modal/drawer; report validation errors and open state. */
export async function saveModal(page, { scope = MODAL, label = "保存" } = {}) {
  await clickButton(page, label, { scope });
  await sleep(1400);
  return { errors: await formErrors(page, scope), stillOpen: await syncScope(page, scope) };
}

/** Close the open drawer (cancel → close icon → Escape) and verify. */
export async function closeDrawer(page) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await syncDrawer(page))) return true;
    await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      const cancel = [...(root?.querySelectorAll("button") ?? [])].find((b) => /キャンセル|閉じる|戻る/.test(b.innerText ?? ""));
      (cancel ?? root?.querySelector(".ant-drawer-close"))?.click();
    }, DRAWER);
    await sleep(600);
    if (!(await syncDrawer(page))) return true;
    await page.keyboard.press("Escape");
    await sleep(600);
  }
  if (await syncDrawer(page)) throw new Error(`closeDrawer: drawer "${await drawerTitle(page)}" refused to close`);
  return true;
}

/** Close the visible modal (cancel → close icon → Escape) and verify. */
export async function closeModal(page) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await syncModal(page))) return true;
    await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      const cancel = [...(root?.querySelectorAll("button") ?? [])].find((b) => /キャンセル|閉じる|戻る/.test(b.innerText ?? ""));
      (cancel ?? root?.querySelector(".ant-modal-close") ?? document.querySelector(".ant-modal-close"))?.click();
    }, MODAL);
    await sleep(600);
    if (!(await syncModal(page))) return true;
    await page.keyboard.press("Escape");
    await sleep(600);
  }
  if (await syncModal(page)) throw new Error(`closeModal: modal "${await modalTitle(page)}" refused to close`);
  return true;
}

/** Confirm a Popconfirm / confirm-modal (delete, submit, …). */
export async function confirmPopup(page, pattern = /はい|OK|確認|削除|提出|保存/) {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src);
    const roots = [
      ...document.querySelectorAll(".ant-popover:not(.ant-popover-hidden), .ant-popconfirm, .ant-modal-confirm"),
      ...[...document.querySelectorAll(".ant-modal-wrap")].filter((w) => getComputedStyle(w).display !== "none"),
    ];
    for (const root of roots) {
      const btn = [...root.querySelectorAll("button")].find((b) => re.test(b.innerText ?? "") && !b.disabled);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }, pattern.source);
  await sleep(1000);
  return ok;
}

/** Latest antd toast/notification texts. */
export async function toasts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".ant-message-notice-content, .ant-notification-notice-message")].map((e) => e.innerText.trim()),
  );
}

/** Text of the active tab pane, whitespace-collapsed. */
export async function paneText(page) {
  return page.evaluate(() => {
    const pane = document.querySelector(".ant-tabs-tabpane-active") ?? document.body;
    return (pane.innerText ?? "").replace(/\s+/g, " ").trim();
  });
}

/** Switch a tab by visible label and wait for the pane to settle. */
export async function openTab(page, label) {
  const ok = await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".ant-tabs-tab-btn")].find((x) => (x.innerText ?? "").includes(t));
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  if (!ok) throw new Error(`openTab: no tab labelled ${label}`);
  await sleep(1000);
  return true;
}
