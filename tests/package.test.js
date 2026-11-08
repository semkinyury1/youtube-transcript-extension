import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["scripts/package.js"], { cwd: root });
const manifest = JSON.parse(readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8"));
const bundle = readFileSync(new URL("../dist/content-script.js", import.meta.url), "utf8");

test("packages a classic content script limited to desktop YouTube origins", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://www.youtube.com/*", "https://youtube.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["content-script.js"]);
  new vm.Script(bundle);
  for (const file of [manifest.action.default_popup, ...manifest.content_scripts[0].js]) {
    assert.ok(readFileSync(new URL(`../dist/${file}`, import.meta.url)).length > 0);
  }
});

test("the actual packaged script loads a modern transcript invisibly and displays its text", async (t) => {
  const fixture = readFileSync(new URL("./fixtures/modern-transcript.html", import.meta.url), "utf8");
  const dom = new JSDOM(`<ytd-watch-flexy video-id="abcdefghijk">
    <ytd-watch-metadata><h1>Проверка готового расширения</h1></ytd-watch-metadata>
    <div id="secondary-inner"></div>
    <ytd-video-description-transcript-section-renderer><button>Показать текст видео</button></ytd-video-description-transcript-section-renderer>
    </ytd-watch-flexy>`, {
    url: "https://www.youtube.com/watch?v=abcdefghijk", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  let nativePanel;
  let hiddenWhileLoading = false;
  doc.querySelector("button").addEventListener("click", () => {
    nativePanel = doc.createElement("ytd-engagement-panel-section-list-renderer");
    nativePanel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    doc.body.append(nativePanel);
    dom.window.setTimeout(() => {
      hiddenWhileLoading = dom.window.getComputedStyle(nativePanel).visibility === "hidden";
      nativePanel.innerHTML = doc.createRange().createContextualFragment(fixture)
        .querySelector('[visibility$="EXPANDED"]').innerHTML;
    }, 20);
  });
  vm.runInContext(bundle, dom.getInternalVMContext());
  const panel = dom.window.document.getElementById("youtube-transcript-extension-panel").shadowRoot;
  panel.getElementById("extract").click();
  const deadline = Date.now() + 2000;
  while (panel.getElementById("body").getAttribute("aria-busy") === "true") {
    if (Date.now() >= deadline) throw new Error("Packaged script failed to finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(panel.getElementById("output").value, "Первая строка новой расшифровки.\nСледующая строка.");
  assert.equal(panel.getElementById("copy").disabled, false);
  assert.match(panel.getElementById("status").textContent, /Готово/);
  assert.equal(hiddenWhileLoading, true);
  assert.equal(nativePanel.getAttribute("visibility"), "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  assert.equal(doc.querySelectorAll("style").length, 0);
});
