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

// ---------------------------------------------------------------------------
// Ant Design v6 interaction helpers.
//
// Two traps this build sets, both handled here:
//  1. Modal bodies live in `.ant-modal-container` (v5's `.ant-modal-content`
//     does not exist).
//  2. Closed modals stay mounted — only their `.ant-modal-wrap` is hidden — so
//     naive selectors keep hitting the previous, invisible dialog. Every helper
//     first tags the VISIBLE dialog with `data-qa-modal="active"` and works
//     inside that tag.
// ---------------------------------------------------------------------------
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

/**
 * Click an enabled button by visible text.
 * EXACT text wins over substring: this screen has both「一時保存」and
 *「一時保存を破棄」, and a substring match would hit the destructive one first.
 */
export async function clickButton(page, text, { scope = "body", nth = 0 } = {}) {
  if (scope === MODAL) await syncModal(page);
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
  if (scope === MODAL) await syncModal(page);
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
  if (scope === MODAL) await syncModal(page);
  return page.evaluate((s) => {
    const root = document.querySelector(s) ?? document.body;
    return [...root.querySelectorAll(".ant-form-item-explain-error")].map((e) => e.innerText.trim());
  }, scope);
}

/** Set a controlled input's value inside the visible modal (React-safe). */
export async function setModalInput(page, selector, value) {
  if (!(await syncModal(page))) throw new Error("setModalInput: no visible modal");
  const ok = await page.evaluate(
    (modal, sel, val) => {
      const el = document.querySelector(`${modal} ${sel}`);
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    MODAL,
    selector,
    value,
  );
  if (!ok) throw new Error(`setModalInput: ${selector} not found in modal`);
  await sleep(250);
  return true;
}

/** Antd Select inside the visible modal: open by input id, pick option text. */
export async function selectOption(page, inputId, optionText) {
  await syncModal(page);
  await page.click(`${MODAL} #${inputId}`).catch(async () => {
    await page.click(`#${inputId}`);
  });
  await page.waitForSelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { timeout: 8000 });
  const picked = await page.evaluate((t) => {
    const opts = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")];
    const hit = opts.find((o) => (o.innerText ?? "").trim() === t) ?? opts.find((o) => (o.innerText ?? "").includes(t));
    if (!hit) return { ok: false, options: opts.map((o) => o.innerText.trim()).slice(0, 30) };
    hit.click();
    return { ok: true };
  }, optionText);
  if (!picked.ok) throw new Error(`selectOption(${inputId}): "${optionText}" not found; options=${JSON.stringify(picked.options)}`);
  await sleep(350);
  return true;
}

/** Antd DatePicker inside the visible modal: type value, commit with Enter. */
export async function pickDate(page, inputId, value) {
  await syncModal(page);
  const sel = `${MODAL} #${inputId}`;
  await page.click(sel);
  await page.$eval(sel, (el) => {
    el.value = "";
  });
  await page.type(sel, value, { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(500);
  return page.$eval(sel, (el) => el.value);
}

/** Click 保存 in the visible modal; report validation errors and open state. */
export async function saveModal(page) {
  await clickButton(page, "保存", { scope: MODAL });
  await sleep(1400);
  return { errors: await formErrors(page, MODAL), stillOpen: await modalOpen(page) };
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
