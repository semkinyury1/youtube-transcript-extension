import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initializePopup } from "../popup.js";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
const tab = { id: 42, url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Урок - YouTube" };
const success = {
  ok: true,
  transcript: {
    videoId: "abcdefghijk", title: "Урок JavaScript", url: tab.url,
    segments: [{ timestamp: "0:00", text: "Привет мир" }, { timestamp: "0:05", text: "Следующая строка" }],
  },
};

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("UI did not settle");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

async function popup(t, overrides = {}) {
  const dom = new JSDOM(html, { url: "https://extension.example/popup.html" });
  t.after(() => dom.window.close());
  let copied = "";
  const chromeApi = {
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { executeScript: async () => [{ result: success }] },
    ...overrides,
  };
  const clipboard = { writeText: async (value) => { copied = value; } };
  await initializePopup(dom.window.document, chromeApi, clipboard);
  const el = (id) => dom.window.document.getElementById(id);
  const load = async () => {
    el("extract").click();
    await waitFor(() => dom.window.document.getElementById("app").getAttribute("aria-busy") === "false");
  };
  return { dom, chromeApi, clipboard, el, load, copied: () => copied };
}

test("shows loading state, then renders text, timestamps and copy output", async (t) => {
  let resolveScript;
  const p = await popup(t, { scripting: { executeScript: () => new Promise((resolve) => { resolveScript = resolve; }) } });
  assert.equal(p.el("copy").disabled, true);
  p.el("extract").click();
  assert.equal(p.el("extract").disabled, true);
  assert.equal(p.el("app").getAttribute("aria-busy"), "true");
  await waitFor(() => resolveScript !== undefined);
  resolveScript([{ result: success }]);
  await waitFor(() => !p.el("copy").disabled);
  assert.equal(p.el("transcript").value, "Привет мир\nСледующая строка");
  p.el("timestamps").click();
  assert.equal(p.el("transcript").value, "[0:00] Привет мир\n[0:05] Следующая строка");
  p.el("copy").click();
  await waitFor(() => p.el("status").textContent === "Текст скопирован.");
  assert.equal(p.copied(), p.el("transcript").value);
  assert.equal(p.el("app").getAttribute("aria-busy"), "false");
});

test("clears an earlier result when a retry has no transcript", async (t) => {
  const p = await popup(t);
  await p.load();
  p.chromeApi.scripting.executeScript = async () => [{ result: { ok: false, message: "Нет расшифровки" } }];
  await p.load();
  assert.equal(p.el("transcript").value, "");
  assert.equal(p.el("video-title").textContent, "");
  assert.equal(p.el("copy").disabled, true);
  assert.equal(p.el("download").disabled, true);
  assert.equal(p.el("timestamps").disabled, true);
  assert.equal(p.el("status").textContent, "Нет расшифровки");
  assert.equal(p.el("extract").disabled, false);
});

test("keeps extraction disabled outside supported YouTube pages", async (t) => {
  const p = await popup(t, { tabs: { query: async () => [{ ...tab, url: "https://example.com" }] } });
  assert.equal(p.el("extract").disabled, true);
  assert.equal(p.el("copy").disabled, true);
  assert.match(p.el("status").textContent, /Откройте/);
});

test("recovers its controls when script injection fails", async (t) => {
  const p = await popup(t, { scripting: { executeScript: async () => { throw new Error("access denied"); } } });
  await p.load();
  assert.equal(p.el("extract").disabled, false);
  assert.equal(p.el("status").dataset.kind, "error");
  assert.equal(p.el("transcript").value, "");
});

test("rejects a successful result when the tab navigated to another video", async (t) => {
  const p = await popup(t, { tabs: {
    query: async () => [tab], get: async () => ({ ...tab, url: "https://www.youtube.com/watch?v=different12" }),
  } });
  await p.load();
  assert.equal(p.el("copy").disabled, true);
  assert.match(p.el("status").textContent, /Видео сменилось/);
});

test("selects the output for manual copying if clipboard access fails", async (t) => {
  const p = await popup(t);
  await p.load();
  p.clipboard.writeText = async () => { throw new Error("denied"); };
  p.el("copy").click();
  await waitFor(() => p.el("status").dataset.kind === "error");
  assert.equal(p.el("transcript").selectionStart, 0);
  assert.equal(p.el("transcript").selectionEnd, p.el("transcript").value.length);
  assert.match(p.el("status").textContent, /Ctrl\+C/);
});

test("downloads a UTF-8 TXT with BOM, Cyrillic text and the chosen timestamps", async (t) => {
  const p = await popup(t);
  await p.load();
  p.el("timestamps").click();
  let blob;
  let name;
  p.dom.window.URL.createObjectURL = (value) => { blob = value; return "blob:preview"; };
  p.dom.window.URL.revokeObjectURL = () => {};
  p.dom.window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  p.el("download").click();
  assert.equal(name, "Урок JavaScript - abcdefghijk.txt");
  assert.equal(blob.type, "text/plain;charset=utf-8");
  const bytes = await new Promise((resolve, reject) => {
    const reader = new p.dom.window.FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
  assert.equal(new TextDecoder().decode(bytes), p.el("transcript").value);
});

test("renders page titles and subtitle markup as literal text", async (t) => {
  const result = { ...success, transcript: {
    ...success.transcript,
    title: '<img src="x" onerror="alert(1)">',
    segments: [{ text: '<script>alert("text")</script>', timestamp: "0:00" }],
  } };
  const p = await popup(t, { scripting: { executeScript: async () => [{ result }] } });
  await p.load();
  assert.equal(p.el("video-title").querySelector("img"), null);
  assert.equal(p.el("video-title").textContent, result.transcript.title);
  assert.equal(p.el("transcript").value, result.transcript.segments[0].text);
});
