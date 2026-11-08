import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installTranscriptPanel } from "../panel.js";

const videoId = "abcdefghijk";
const nextVideoId = "different12";
const success = {
  ok: true,
  transcript: { videoId, title: "Пример видео", segments: [{ timestamp: "0:01", text: "Пример расшифровки" }] },
};

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Panel did not settle");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

function setup(t, readTranscript = async () => success, url = `https://www.youtube.com/watch?v=${videoId}`) {
  const dom = new JSDOM(`<ytd-watch-flexy video-id="${videoId}">
    <ytd-watch-metadata><h1>Пример видео</h1></ytd-watch-metadata>
    <div id="secondary"><div id="secondary-inner"><div id="recommendations">Рекомендации</div></div></div>
    <div id="below"></div>
  </ytd-watch-flexy>`, { url });
  const doc = dom.window.document;
  const panel = installTranscriptPanel(doc, readTranscript);
  t.after(() => { panel.dispose(); dom.window.close(); });
  const el = (id) => panel.host.shadowRoot.getElementById(id);
  const load = async () => {
    el("extract").click();
    await waitFor(() => el("body").getAttribute("aria-busy") === "false");
  };
  return { dom, doc, panel, el, load };
}

test("adds one panel above recommendations and preserves page content", (t) => {
  const p = setup(t);
  assert.equal(p.doc.getElementById("secondary-inner").firstElementChild, p.panel.host);
  assert.equal(p.doc.getElementById("recommendations").textContent, "Рекомендации");
  assert.equal(installTranscriptPanel(p.doc), null);
  assert.equal(p.doc.querySelectorAll("#youtube-transcript-extension-panel").length, 1);
});

test("loads, collapses and expands without losing the result, and adds timestamps", async (t) => {
  const p = setup(t);
  await p.load();
  assert.equal(p.el("output").value, "Пример расшифровки");
  p.el("toggle").click();
  assert.equal(p.el("body").hidden, true);
  p.el("toggle").click();
  assert.equal(p.el("output").value, "Пример расшифровки");
  p.el("timestamps").click();
  assert.equal(p.el("output").value, "[0:01] Пример расшифровки");
});

test("cancels loading on navigation and ignores a late result for the old video", async (t) => {
  let resolve;
  let signal;
  const p = setup(t, (options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); });
  p.el("extract").click();
  assert.equal(p.el("body").getAttribute("aria-busy"), "true");
  p.doc.dispatchEvent(new p.dom.window.Event("yt-navigate-start"));
  assert.equal(signal.aborted, true);
  p.panel.sync();
  assert.equal(p.el("extract").disabled, true);
  p.dom.window.history.replaceState(null, "", `/watch?v=${nextVideoId}`);
  p.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", nextVideoId);
  p.doc.dispatchEvent(new p.dom.window.Event("yt-navigate-finish"));
  resolve(success);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(p.el("output").value, "");
  assert.equal(p.el("copy").disabled, true);
  assert.equal(p.el("extract").disabled, false);
  assert.match(p.el("status").textContent, /Нажмите/);
});

test("clears the old transcript when navigating between videos without a reload", async (t) => {
  const p = setup(t);
  await p.load();
  p.dom.window.history.replaceState(null, "", `/watch?v=${nextVideoId}`);
  p.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", nextVideoId);
  p.doc.dispatchEvent(new p.dom.window.Event("yt-navigate-finish"));
  assert.equal(p.el("output").value, "");
  assert.equal(p.el("copy").disabled, true);
});

test("does not mount on the YouTube home page, then mounts after SPA navigation to a video", (t) => {
  const p = setup(t, undefined, "https://www.youtube.com/");
  assert.equal(p.panel.host.isConnected, false);
  p.dom.window.history.replaceState(null, "", `/watch?v=${videoId}`);
  p.doc.dispatchEvent(new p.dom.window.Event("yt-navigate-finish"));
  assert.equal(p.panel.host.isConnected, true);
});

test("reattaches when YouTube replaces the sidebar", async (t) => {
  const p = setup(t);
  const replacement = p.doc.createElement("div");
  replacement.id = "secondary-inner";
  p.doc.getElementById("secondary-inner").replaceWith(replacement);
  await waitFor(() => p.panel.host.parentNode === replacement);
  assert.equal(p.doc.querySelectorAll("#youtube-transcript-extension-panel").length, 1);
});

test("shows an extraction error and allows retry without exposing an old result", async (t) => {
  let attempts = 0;
  const p = setup(t, async () => ++attempts === 1 ? success : ({ ok: false, message: "Расшифровка недоступна" }));
  await p.load();
  await p.load();
  assert.equal(p.el("output").value, "");
  assert.equal(p.el("download").disabled, true);
  assert.equal(p.el("extract").disabled, false);
  assert.equal(p.el("status").textContent, "Расшифровка недоступна");
});

test("copies the displayed transcript from the page panel", async (t) => {
  const p = setup(t);
  let copied;
  Object.defineProperty(p.dom.window.navigator, "clipboard", { value: { writeText: async (text) => { copied = text; } } });
  await p.load();
  p.el("timestamps").click();
  p.el("copy").click();
  await waitFor(() => p.el("status").textContent === "Текст скопирован.");
  assert.equal(copied, "[0:01] Пример расшифровки");
});

test("uses YouTube dark mode without applying styles to its player", (t) => {
  const p = setup(t);
  p.doc.documentElement.setAttribute("dark", "");
  p.panel.sync();
  assert.equal(p.panel.host.dataset.theme, "dark");
  assert.equal(p.doc.querySelector("style"), null);
});

test("allows manual copying when page clipboard access is unavailable", async (t) => {
  const p = setup(t);
  await p.load();
  p.el("copy").click();
  await waitFor(() => p.el("status").dataset.kind === "error");
  assert.equal(p.el("output").selectionStart, 0);
  assert.equal(p.el("output").selectionEnd, p.el("output").value.length);
  assert.match(p.el("status").textContent, /Ctrl\+C/);
});

test("saves the page panel text as a UTF-8 TXT with timestamps", async (t) => {
  const p = setup(t);
  await p.load();
  p.el("timestamps").click();
  let blob;
  let filename;
  p.dom.window.URL.createObjectURL = (value) => { blob = value; return "blob:local-test"; };
  p.dom.window.URL.revokeObjectURL = () => {};
  p.dom.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  p.el("download").click();
  assert.equal(filename, "Пример видео — abcdefghijk.txt");
  const bytes = await new Promise((resolve, reject) => {
    const reader = new p.dom.window.FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
  assert.equal(new TextDecoder().decode(bytes), "[0:01] Пример расшифровки");
});
