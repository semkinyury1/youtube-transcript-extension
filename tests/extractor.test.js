import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { readYouTubeTranscript } from "../extractor.js";

const videoId = "abcdefghijk";
const url = `https://www.youtube.com/watch?v=${videoId}`;
const modernTranscript = await readFile(new URL("./fixtures/modern-transcript.html", import.meta.url), "utf8");
const segment = (text, timestamp = "0:00") => `<ytd-transcript-segment-renderer>
  <div class="segment-timestamp">${timestamp}</div>
  <yt-formatted-string class="segment-text">${text}</yt-formatted-string>
</ytd-transcript-segment-renderer>`;
const transcript = (rows) => `<ytd-engagement-panel-section-list-renderer
  target-id="engagement-panel-searchable-transcript">
  <ytd-transcript-renderer>${rows}</ytd-transcript-renderer>
</ytd-engagement-panel-section-list-renderer>`;

function page(t, content, options = {}) {
  const dom = new JSDOM(`<title>Запасное название - YouTube</title>
    <ytd-watch-flexy video-id="${videoId}">
      <ytd-watch-metadata><h1>Пример видео</h1></ytd-watch-metadata>${content}
    </ytd-watch-flexy>`, { url, runScripts: "outside-only", ...options });
  t.after(() => dom.window.close());
  return dom;
}

// Run the serialized function in a separate page realm, as executeScript does.
function extract(dom, options = {}) {
  return vm.runInContext(`(${readYouTubeTranscript.toString()})({...${JSON.stringify({
    timeoutMs: 250, pollIntervalMs: 3, settleMs: 10, ...options,
  })}, signal: window.testSignal})`, dom.getInternalVMContext());
}

function backgroundPage(t, { modern = false, renderRows = true } = {}) {
  const dom = page(t, '<ytd-video-description-transcript-section-renderer><button>Показать текст видео</button></ytd-video-description-transcript-section-renderer>');
  const doc = dom.window.document;
  let panel;
  let wasHiddenDuringLoading = false;
  let closeClicks = 0;
  doc.querySelector("button").addEventListener("click", () => {
    panel = doc.createElement("ytd-engagement-panel-section-list-renderer");
    if (!modern) panel.setAttribute("target-id", "engagement-panel-searchable-transcript");
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    panel.innerHTML = '<ytd-engagement-panel-title-header-renderer><div id="visibility-button"><button>Закрыть</button></div></ytd-engagement-panel-title-header-renderer>';
    panel.querySelector("button").addEventListener("click", () => {
      closeClicks++;
      panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    });
    // The modern panel can appear outside watch-flexy before it has any rows.
    doc.body.append(panel);
    dom.window.setTimeout(() => {
      const style = dom.window.getComputedStyle(panel);
      wasHiddenDuringLoading = style.visibility === "hidden" && style.position === "fixed";
      if (renderRows) {
        panel.insertAdjacentHTML("beforeend", modern
          ? doc.createRange().createContextualFragment(modernTranscript)
            .querySelector('ytd-engagement-panel-section-list-renderer[visibility$="EXPANDED"]').innerHTML
          : `<ytd-transcript-renderer>${segment("Текст без всплывающей панели")}</ytd-transcript-renderer>`);
      }
    }, 10);
  });
  return { dom, doc, get panel() { return panel; },
    get wasHiddenDuringLoading() { return wasHiddenDuringLoading; },
    get closeClicks() { return closeClicks; } };
}

for (const modern of [false, true]) {
  test(`loads ${modern ? "modern" : "legacy"} transcript offscreen and closes only its automatic panel`, async (t) => {
    const setup = backgroundPage(t, { modern });
    const result = await extract(setup.dom);
    assert.equal(result.ok, true, result.message);
    assert.equal(setup.wasHiddenDuringLoading, true, "the native panel must be hidden before rows arrive");
    assert.equal(setup.closeClicks, 1);
    assert.equal(setup.panel.getAttribute("visibility"), "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    assert.equal(setup.doc.querySelectorAll("style").length, 0, "temporary styles must be removed");
    assert.equal(setup.panel.getAttributeNames().some((name) => name.startsWith("data-yte-background-")), false);
    // Reopening the native panel manually must work without leftover hiding styles.
    setup.panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    assert.notEqual(setup.dom.window.getComputedStyle(setup.panel).visibility, "hidden");
  });
}

test("leaves a manually opened native transcript visible and does not close it", async (t) => {
  const dom = page(t, modernTranscript);
  const doc = dom.window.document;
  const panel = doc.querySelector('ytd-engagement-panel-section-list-renderer[visibility$="EXPANDED"]');
  let closeClicks = 0;
  panel.insertAdjacentHTML("afterbegin", '<div id="visibility-button"><button>Закрыть</button></div>');
  panel.querySelector("button").addEventListener("click", () => closeClicks++);
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(closeClicks, 0);
  assert.notEqual(dom.window.getComputedStyle(panel).visibility, "hidden");
  assert.equal(panel.getAttribute("visibility"), "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
});

test("cleans up an automatically opened loading panel after a timeout", async (t) => {
  const setup = backgroundPage(t, { modern: true, renderRows: false });
  const result = await extract(setup.dom, { timeoutMs: 60 });
  assert.equal(result.code, "TRANSCRIPT_TIMEOUT");
  assert.equal(setup.wasHiddenDuringLoading, true);
  assert.equal(setup.closeClicks, 1);
  assert.equal(setup.doc.querySelectorAll("style").length, 0);
});

test("cleans up an automatically opened loading panel when extraction is cancelled", async (t) => {
  const setup = backgroundPage(t, { modern: true, renderRows: false });
  const controller = new setup.dom.window.AbortController();
  setup.dom.window.testSignal = controller.signal;
  setup.dom.window.setTimeout(() => controller.abort(), 30);
  const result = await extract(setup.dom);
  assert.equal(result.code, "CANCELLED");
  assert.equal(setup.wasHiddenDuringLoading, true);
  assert.equal(setup.closeClicks, 1);
  assert.equal(setup.doc.querySelectorAll("style").length, 0);
});

test("does not hide or close unrelated native panels during background loading", async (t) => {
  const setup = backgroundPage(t);
  setup.doc.body.insertAdjacentHTML("beforeend", '<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"><div id="visibility-button"><button>Комментарии</button></div></ytd-engagement-panel-section-list-renderer>');
  const comments = setup.doc.querySelector('[target-id="engagement-panel-comments-section"]');
  let commentsClosed = false;
  let commentsHidden = false;
  comments.querySelector("button").addEventListener("click", () => { commentsClosed = true; });
  setup.dom.window.setTimeout(() => {
    commentsHidden = setup.dom.window.getComputedStyle(comments).visibility === "hidden";
  }, 10);
  const result = await extract(setup.dom);
  assert.equal(result.ok, true);
  assert.equal(commentsClosed, false);
  assert.equal(commentsHidden, false);
});

test("hides an existing closed native panel before clicking Show transcript", async (t) => {
  const dom = page(t, '<ytd-video-description-transcript-section-renderer><button>Показать текст видео</button></ytd-video-description-transcript-section-renderer>'
    + '<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>');
  const doc = dom.window.document;
  const panel = doc.querySelector("ytd-engagement-panel-section-list-renderer");
  let hiddenBeforeClick = false;
  doc.querySelector("button").addEventListener("click", () => {
    hiddenBeforeClick = dom.window.getComputedStyle(panel).visibility === "hidden";
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    panel.innerHTML = `<ytd-transcript-renderer>${segment("Текст")}</ytd-transcript-renderer>`;
  });
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(hiddenBeforeClick, true);
  assert.equal(panel.getAttribute("visibility"), "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
});

test("closes a modern panel without a known close button and lets YouTube reopen it", async (t) => {
  const setup = backgroundPage(t, { modern: true });
  setup.doc.querySelector("button").addEventListener("click", () => {
    setup.panel.querySelector("#visibility-button").remove();
    // Model the native custom element's reflected visibility property.
    Object.defineProperty(setup.panel, "visibility", {
      get() { return this.getAttribute("visibility"); },
      set(value) { this.setAttribute("visibility", value); },
    });
  });
  const result = await extract(setup.dom);
  assert.equal(result.ok, true);
  assert.equal(setup.panel.visibility, "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  setup.panel.visibility = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  assert.notEqual(setup.dom.window.getComputedStyle(setup.panel).visibility, "hidden");
  assert.equal(setup.doc.querySelectorAll("style").length, 0);
});

test("removes temporary styles on navigation without closing the next video's reused panel", async (t) => {
  const setup = backgroundPage(t, { modern: true, renderRows: false });
  setup.dom.window.setTimeout(() => {
    setup.dom.window.history.replaceState(null, "", "/watch?v=different12");
    setup.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", "different12");
  }, 25);
  const result = await extract(setup.dom);
  assert.equal(result.code, "VIDEO_CHANGED");
  assert.equal(setup.closeClicks, 0);
  assert.equal(setup.doc.querySelectorAll("style").length, 0);
  assert.notEqual(setup.dom.window.getComputedStyle(setup.panel).visibility, "hidden");
});

test("does not close the next video's reused panel when its video-id changes before the URL", async (t) => {
  const setup = backgroundPage(t, { modern: true, renderRows: false });
  const controller = new setup.dom.window.AbortController();
  setup.dom.window.testSignal = controller.signal;
  setup.dom.window.setTimeout(() => {
    setup.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", "different12");
    controller.abort();
  }, 25);
  const result = await extract(setup.dom);
  assert.equal(result.code, "CANCELLED");
  assert.equal(setup.closeClicks, 0);
  assert.equal(setup.doc.querySelectorAll("style").length, 0);
  assert.notEqual(setup.dom.window.getComputedStyle(setup.panel).visibility, "hidden");
});

test("reads modern rows in an expanded panel without target-id or ytd-transcript-renderer", async (t) => {
  const dom = page(t, modernTranscript);
  const result = await extract(dom);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(JSON.stringify(result.transcript.segments)), [
    { text: "Первая строка новой расшифровки.", timestamp: "0:01" },
    { text: "Следующая строка.", timestamp: "0:12" },
  ]);
});

test("opens a modern transcript automatically instead of timing out after a successful button click", async (t) => {
  const dom = page(t, '<ytd-video-description-transcript-section-renderer><button>Показать текст видео</button></ytd-video-description-transcript-section-renderer>');
  const doc = dom.window.document;
  doc.querySelector("button").addEventListener("click", () => {
    dom.window.setTimeout(() => doc.querySelector("ytd-watch-flexy").insertAdjacentHTML("beforeend", modernTranscript), 10);
  });
  const result = await extract(dom);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.transcript.segments.length, 2);
});

test("finds a modern panel outside watch-flexy and ignores hidden obsolete rows", async (t) => {
  const dom = page(t, `<div hidden>${transcript(segment("Старый текст"))}</div>`);
  dom.window.document.body.insertAdjacentHTML("beforeend", modernTranscript);
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(result.transcript.segments[0].text, "Первая строка новой расшифровки.");
});

test("identifies unsupported row markup as a format error instead of a slow-loading video", async (t) => {
  const dom = page(t, '<ytd-engagement-panel-section-list-renderer visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"><transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">0:01</div><div class="unknown-subtitle-format">Текст</div></transcript-segment-view-model></ytd-engagement-panel-section-list-renderer>');
  const result = await extract(dom, { timeoutMs: 25 });
  assert.equal(result.code, "TRANSCRIPT_FORMAT_UNSUPPORTED");
});

test("stops waiting when an inline panel cancels extraction", async (t) => {
  const dom = page(t, "");
  const controller = new dom.window.AbortController();
  dom.window.testSignal = controller.signal;
  dom.window.setTimeout(() => controller.abort(), 5);
  const result = await extract(dom);
  assert.equal(result.code, "CANCELLED");
});

test("reads the open transcript, cleans whitespace, and keeps repeats and literal markup", async (t) => {
  const dom = page(t, transcript(
    segment("Привет\n  мир", "\u200e0:00") + segment("Привет мир", "0:02")
    + segment(" ", "0:03") + segment("&lt;script&gt;это текст&lt;/script&gt;", ""),
  ));
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(result.transcript.title, "Пример видео");
  assert.equal(result.transcript.url, url);
  assert.deepEqual(JSON.parse(JSON.stringify(result.transcript.segments)), [
    { text: "Привет мир", timestamp: "0:00" },
    { text: "Привет мир", timestamp: "0:02" },
    { text: "<script>это текст</script>", timestamp: "" },
  ]);
});

test("expands the description and opens the transcript using language-independent selectors", async (t) => {
  const dom = page(t, '<div id="description-inline-expander"><button id="expand">más</button></div>');
  const doc = dom.window.document;
  let expandClicks = 0;
  let transcriptClicks = 0;
  doc.getElementById("expand").addEventListener("click", () => {
    expandClicks++;
    const section = doc.createElement("ytd-video-description-transcript-section-renderer");
    section.innerHTML = '<button>Mostrar transcripción</button>';
    section.querySelector("button").addEventListener("click", () => {
      transcriptClicks++;
      dom.window.setTimeout(() => section.insertAdjacentHTML("afterend", transcript(segment("Hola"))), 15);
    });
    doc.querySelector("ytd-watch-flexy").append(section);
  });
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(result.transcript.segments[0].text, "Hola");
  assert.equal(expandClicks, 1);
  assert.equal(transcriptClicks, 1);
});

test("waits for rows to finish rendering rather than returning the first row", async (t) => {
  const dom = page(t, transcript(segment("Первая строка")));
  dom.window.setTimeout(() => {
    dom.window.document.querySelector("ytd-transcript-renderer")
      .insertAdjacentHTML("beforeend", segment("Последняя строка", "1:00"));
  }, 25);
  const result = await extract(dom, { settleMs: 60 });
  assert.equal(result.transcript.segments.length, 2);
  assert.equal(result.transcript.segments[1].text, "Последняя строка");
});

test("does not read subtitle-looking rows outside the transcript panel", async (t) => {
  const dom = page(t, segment("Посторонний текст"));
  const result = await extract(dom, { timeoutMs: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRANSCRIPT_UNAVAILABLE");
});

test("reports unavailable transcript without claiming that loading timed out", async (t) => {
  const dom = page(t, "");
  const result = await extract(dom, { timeoutMs: 25 });
  assert.equal(result.code, "TRANSCRIPT_UNAVAILABLE");
});

test("reports a timeout when the transcript button did not produce rows", async (t) => {
  const dom = page(t, '<ytd-video-description-transcript-section-renderer><button>Показать текст видео</button></ytd-video-description-transcript-section-renderer>');
  const result = await extract(dom, { timeoutMs: 25 });
  assert.equal(result.code, "TRANSCRIPT_TIMEOUT");
});

test("rejects an obsolete watch page after YouTube navigation", async (t) => {
  const dom = page(t, transcript(segment("Старое видео")));
  dom.window.document.querySelector("ytd-watch-flexy").setAttribute("video-id", "different12");
  const result = await extract(dom, { timeoutMs: 25 });
  assert.equal(result.code, "PAGE_NOT_READY");
});

test("stops if the user switches to another video while rows are loading", async (t) => {
  const dom = page(t, transcript(segment("Старое видео")));
  dom.window.setTimeout(() => dom.window.history.replaceState(null, "", "/watch?v=different12"), 5);
  const result = await extract(dom, { settleMs: 40 });
  assert.equal(result.code, "VIDEO_CHANGED");
});

test("waits for an active loading indicator to disappear", async (t) => {
  const dom = page(t, transcript('<tp-yt-paper-spinner active></tp-yt-paper-spinner>' + segment("Текст")));
  let finishedLoading = false;
  dom.window.setTimeout(() => {
    finishedLoading = true;
    dom.window.document.querySelector("tp-yt-paper-spinner").remove();
  }, 20);
  const result = await extract(dom);
  assert.equal(result.ok, true);
  assert.equal(finishedLoading, true);
});

test("refuses unsupported origins before touching the page", async (t) => {
  const dom = page(t, transcript(segment("Не читать")), { url: "https://example.com/watch?v=abcdefghijk" });
  const result = await extract(dom);
  assert.equal(result.code, "UNSUPPORTED_PAGE");
});
