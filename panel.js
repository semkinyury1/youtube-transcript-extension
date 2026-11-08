import { readYouTubeTranscript } from "./extractor.js";
import { createDownloadName, formatTranscript, getVideoId } from "./transcript.js";

export function installTranscriptPanel(doc, readTranscript = readYouTubeTranscript) {
  if (doc.getElementById("youtube-transcript-extension-panel")) return null;
  const view = doc.defaultView;
  const host = doc.createElement("div");
  host.id = "youtube-transcript-extension-panel";
  const root = host.attachShadow({ mode: "open" });
  // Only static extension markup enters innerHTML. Video titles and text use textContent/value.
  root.innerHTML = `
    <style>
      :host { display:block; margin-bottom:16px; font:14px/1.5 system-ui,sans-serif;
        --bg:#fff; --fg:#0f0f0f; --muted:#606060; --border:#ddd; --field:#fafafa; color:var(--fg); }
      :host([data-theme="dark"]) { --bg:#202020; --fg:#f1f1f1; --muted:#aaa; --border:#454545; --field:#181818; }
      * { box-sizing:border-box; }
      .card { padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--bg); }
      header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
      h2 { margin:0; font-size:18px; }
      p { margin:10px 0; overflow-wrap:anywhere; }
      .hint { color:var(--muted); font-size:12px; }
      #title { font-weight:600; }
      #status { min-height:21px; }
      #status[data-kind="error"] { color:#d7463e; }
      button { padding:9px 12px; border:1px solid var(--border); border-radius:7px;
        background:var(--bg); color:var(--fg); font:inherit; cursor:pointer; }
      button:disabled { opacity:.5; cursor:default; }
      #toggle { padding:5px 8px; font-size:12px; }
      #extract { width:100%; background:#1967d2; border-color:#1967d2; color:#fff; }
      button:focus-visible,textarea:focus-visible,input:focus-visible { outline:2px solid #4285f4; outline-offset:2px; }
      label { display:flex; gap:6px; align-items:center; margin:10px 0; }
      input { accent-color:#1967d2; }
      textarea { display:block; width:100%; height:260px; min-height:160px; max-height:480px;
        padding:10px; border:1px solid var(--border); border-radius:7px;
        background:var(--field); color:var(--fg); font:inherit; resize:vertical; }
      .actions { display:flex; gap:8px; margin-top:10px; }
      .actions button { flex:1; }
      [hidden] { display:none; }
      .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    </style>
    <section class="card" aria-label="Текст видео YouTube">
      <header><h2>Текст видео</h2><button id="toggle" type="button" aria-expanded="true" aria-controls="body">Свернуть</button></header>
      <div id="body" aria-busy="false">
        <p class="hint">Расшифровка из субтитров YouTube</p>
        <p id="title"></p>
        <button id="extract" type="button">Получить текст</button>
        <p id="status" role="status" aria-live="polite"></p>
        <label><input id="timestamps" type="checkbox" disabled>Добавить таймкоды</label>
        <label class="sr-only" for="output">Расшифровка видео</label>
        <textarea id="output" readonly dir="auto" placeholder="Здесь появится текст видео."></textarea>
        <div class="actions"><button id="copy" type="button" disabled>Копировать</button><button id="download" type="button" disabled>Скачать TXT</button></div>
      </div>
    </section>`;
  const el = (id) => root.getElementById(id);
  let videoId = null;
  let transcript = null;
  let requestId = 0;
  let controller = null;
  let syncTimer = null;
  let disposed = false;
  let navigating = false;

  function status(message, kind = "info") {
    el("status").textContent = message;
    el("status").dataset.kind = kind;
  }
  function render() {
    el("output").value = transcript ? formatTranscript(transcript.segments, el("timestamps").checked) : "";
    el("timestamps").disabled = el("copy").disabled = el("download").disabled = !transcript;
  }
  function cancel() {
    requestId++;
    controller?.abort();
    controller = null;
    el("body").setAttribute("aria-busy", "false");
    el("extract").textContent = "Получить текст";
  }
  function sync() {
    if (disposed) return;
    const nextId = getVideoId(view.location.href);
    if (nextId !== videoId) {
      cancel();
      videoId = nextId;
      transcript = null;
      render();
      el("title").textContent = "";
      status("Нажмите «Получить текст».");
    }
    if (!nextId) {
      host.remove();
      return;
    }
    const watch = doc.querySelector("ytd-watch-flexy");
    const ready = !navigating && watch && (!watch.getAttribute("video-id") || watch.getAttribute("video-id") === nextId);
    const container = watch?.querySelector("#secondary-inner") ?? watch?.querySelector("#secondary") ?? watch?.querySelector("#below");
    if (container && host.parentNode !== container) container.prepend(host);
    host.dataset.theme = doc.documentElement.hasAttribute("dark") ? "dark" : "light";
    if (el("body").getAttribute("aria-busy") !== "true") el("extract").disabled = !ready;
    if (!transcript) el("title").textContent = ready
      ? (watch.querySelector("ytd-watch-metadata h1")?.textContent ?? "").trim() : "";
  }
  function scheduleSync() {
    if (syncTimer !== null || disposed) return;
    syncTimer = view.setTimeout(() => { syncTimer = null; sync(); }, 100);
  }

  el("toggle").addEventListener("click", () => {
    el("body").hidden = !el("body").hidden;
    el("toggle").textContent = el("body").hidden ? "Развернуть" : "Свернуть";
    el("toggle").setAttribute("aria-expanded", String(!el("body").hidden));
  });
  el("timestamps").addEventListener("change", render);
  el("extract").addEventListener("click", async () => {
    sync();
    if (!videoId || el("extract").disabled) return;
    cancel();
    const thisRequest = requestId;
    const thisVideo = videoId;
    controller = new view.AbortController();
    transcript = null;
    render();
    el("extract").disabled = true;
    el("extract").textContent = "Загружаю…";
    el("body").setAttribute("aria-busy", "true");
    status("Получаю расшифровку YouTube…");
    try {
      const result = await readTranscript({ signal: controller.signal });
      if (thisRequest !== requestId || getVideoId(view.location.href) !== thisVideo) return;
      if (!result.ok) {
        if (result.code !== "CANCELLED") status(result.message, "error");
        return;
      }
      if (result.transcript.videoId !== thisVideo) {
        status("Видео сменилось. Повторите получение текста.", "error");
        return;
      }
      transcript = result.transcript;
      el("title").textContent = transcript.title;
      render();
      status(`Готово. Строк в расшифровке: ${transcript.segments.length}.`);
    } catch {
      if (thisRequest === requestId) status("Не удалось получить текст. Нажмите «Получить текст», чтобы повторить попытку.", "error");
    } finally {
      if (thisRequest === requestId) {
        controller = null;
        el("body").setAttribute("aria-busy", "false");
        el("extract").disabled = false;
        el("extract").textContent = "Получить текст";
      }
    }
  });
  el("copy").addEventListener("click", async () => {
    sync();
    if (!transcript) return;
    const thisRequest = requestId;
    try {
      await view.navigator.clipboard.writeText(el("output").value);
      if (thisRequest === requestId) status("Текст скопирован.");
    } catch {
      if (thisRequest !== requestId) return;
      el("output").focus();
      el("output").select();
      status("Текст выделен — нажмите Ctrl+C или ⌘C для копирования.", "error");
    }
  });
  el("download").addEventListener("click", () => {
    sync();
    if (!transcript) return;
    const blob = new view.Blob(["\ufeff", el("output").value], { type: "text/plain;charset=utf-8" });
    const url = view.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = createDownloadName(transcript.title, transcript.videoId);
    doc.body.append(link);
    link.click();
    link.remove();
    view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
    status("TXT передан браузеру для сохранения.");
  });

  // YouTube is an SPA: reset results on navigation and reattach after layout changes.
  const observer = new view.MutationObserver(scheduleSync);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["video-id", "dark"] });
  const onNavigationStart = () => {
    navigating = true;
    cancel();
    transcript = null;
    render();
    el("extract").disabled = true;
    status("Загружается страница видео…");
  };
  const onNavigationFinish = () => { navigating = false; sync(); };
  doc.addEventListener("yt-navigate-start", onNavigationStart);
  doc.addEventListener("yt-navigate-finish", onNavigationFinish);
  view.addEventListener("popstate", sync);
  sync();
  return {
    host,
    sync,
    dispose() {
      disposed = true;
      cancel();
      observer.disconnect();
      if (syncTimer !== null) view.clearTimeout(syncTimer);
      doc.removeEventListener("yt-navigate-start", onNavigationStart);
      doc.removeEventListener("yt-navigate-finish", onNavigationFinish);
      view.removeEventListener("popstate", sync);
      host.remove();
    },
  };
}
