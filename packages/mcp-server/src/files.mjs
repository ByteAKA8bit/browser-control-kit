// Bytes cross the tool boundary here: an agent hands over a path or inline
// content, and a download comes back as a path it can read or upload again.
// Non-goal: sandboxing. browser_script can already require("node:fs"), so a
// path given to a tool is exactly as trusted as one given to a script.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where an unnamed download lands; BC_DOWNLOAD_DIR moves it. */
export const downloadDir = () =>
  process.env.BC_DOWNLOAD_DIR ?? path.join(process.env.BC_SHIM_LOG_DIR ?? path.join(os.homedir(), ".cache", "browser-control"), "downloads");

/**
 * Turn the upload tool's entries into `{ name, buffer, type }`: a path, or an
 * object with `path`, `base64` or `text`.
 * @param {Array<string|object>} files
 */
export function uploads(files) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error('browser_upload needs "files": one or more paths, or {name, base64} / {name, text} objects');
  }
  return files.map((file) => {
    if (typeof file === "string") return { name: path.basename(file), buffer: readFileSync(file) };
    if (file?.path) return { name: file.name ?? path.basename(file.path), buffer: readFileSync(file.path), type: file.type };
    if (typeof file?.base64 === "string") return { name: file.name ?? "upload.bin", buffer: Buffer.from(file.base64, "base64"), type: file.type };
    if (typeof file?.text === "string") return { name: file.name ?? "upload.txt", buffer: Buffer.from(file.text, "utf8"), type: file.type ?? "text/plain" };
    throw new Error(`unsupported file entry ${JSON.stringify(file)?.slice(0, 80)}: pass a path, {path}, {name,base64} or {name,text}`);
  });
}

/**
 * Runs INSIDE the page: fetch a URL with the page's cookies and return base64.
 * Chrome's own download plumbing is not exposed on the extension transport
 * (measured 2026-10-29: `download` never fires, `goto` fails "Download is
 * starting"), so the bytes travel through the page instead. No imports.
 */
export const FETCH_IN_PAGE = async function fetchInPage(url, ms, max) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const declared = Number(response.headers.get("content-length"));
    if (declared > max) return { ok: false, reason: `the response declares ${declared} bytes, over BC_MCP_DOWNLOAD_MAX=${max}` };
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(disposition);
    let name = match ? decodeURIComponent(match[1].trim()) : "";
    if (!name) {
      try {
        name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {} // data: URLs have no path
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) return { ok: false, reason: `the response is ${bytes.length} bytes, over BC_MCP_DOWNLOAD_MAX=${max}` };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ok: true, base64: btoa(binary), name: name || "download.bin", type: response.headers.get("content-type") ?? "", bytes: bytes.length };
  } catch (err) {
    if (err?.name === "AbortError") return { ok: false, reason: `no response within ${ms}ms` };
    return { ok: false, reason: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
};

/** Save bytes fetched in-page to `target`, or under their own name in downloadDir(). */
export function saveBytes({ base64, name }, target) {
  const file = path.resolve(target ?? path.join(downloadDir(), path.basename(name || "download.bin")));
  const buffer = Buffer.from(base64, "base64");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buffer);
  let size = buffer.length;
  try {
    size = statSync(file).size;
  } catch {} // the write resolved, so a missing stat is not a failed download
  return { path: file, name: path.basename(name || file), size };
}
