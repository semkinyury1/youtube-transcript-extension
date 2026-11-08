import { readYouTubeTranscript } from "./extractor.js";
import { createDownloadName, formatTranscript, getVideoId } from "./transcript.js";

export async function initializePopup(doc, chromeApi, clipboard) {
  const app = doc.getElementById("app");
  const title = doc.getElementById("video-title");
  const extract = doc.getElementById("extract");
  const status = doc.getElementById("status");
  const timestamps = doc.getElementById("timestamps");
  const output = doc.getElementById("transcript");
  const copy = doc.getElementById("copy");
  const download = doc.getElementById("download");
  let transcript = null;

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function renderOutput() {
    output.value = transcript ? formatTranscript(transcript.segments, timestamps.checked) : "";
    timestamps.disabled = copy.disabled = download.disabled = !transcript;
  }

  extract.addEventListener("click", async () => {
    transcript = null;
    renderOutput();
    title.textContent = "";
    extract.disabled = true;
    extract.textContent = "Загружаю…";
    app.setAttribute("aria-busy", "true");
    setStatus("Открываю расшифровку YouTube. Оставьте это окно открытым…");
    try {
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const videoId = getVideoId(tab?.url);
      if (!videoId || !Number.isInteger(tab?.id)) {
        setStatus("Откройте обычную страницу видео на youtube.com. Shorts пока не поддерживаются.", "error");
        return;
      }
      const [injection] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        func: readYouTubeTranscript,
      });
      const result = injection?.result;
      if (!result) {
        setStatus("Не удалось прочитать страницу. Обновите вкладку YouTube и попробуйте снова.", "error");
        return;
      }
      if (!result.ok) {
        setStatus(result.message, "error");
        return;
      }
      const currentTab = await chromeApi.tabs.get(tab.id);
      if (getVideoId(currentTab.url) !== videoId || result.transcript.videoId !== videoId) {
        setStatus("Видео сменилось во время загрузки. Нажмите «Получить текст» ещё раз.", "error");
        return;
      }
      transcript = result.transcript;
      title.textContent = transcript.title;
      renderOutput();
      setStatus(`Готово. Строк в расшифровке: ${transcript.segments.length}.`);
    } catch {
      setStatus("Не удалось прочитать вкладку. Обновите страницу YouTube и откройте расширение снова.", "error");
    } finally {
      app.setAttribute("aria-busy", "false");
      extract.disabled = false;
      extract.textContent = "Получить текст";
    }
  });

  timestamps.addEventListener("change", renderOutput);
  copy.addEventListener("click", async () => {
    try {
      await clipboard.writeText(output.value);
      setStatus("Текст скопирован.");
    } catch {
      output.focus();
      output.select();
      setStatus("Не удалось скопировать автоматически. Текст выделен — нажмите Ctrl+C или ⌘C.", "error");
    }
  });

  download.addEventListener("click", () => {
    if (!transcript) return;
    const blob = new doc.defaultView.Blob(["\ufeff", output.value], { type: "text/plain;charset=utf-8" });
    const url = doc.defaultView.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = createDownloadName(transcript.title, transcript.videoId);
    doc.body.append(link);
    link.click();
    link.remove();
    doc.defaultView.setTimeout(() => doc.defaultView.URL.revokeObjectURL(url), 1000);
    setStatus("TXT передан браузеру для сохранения.");
  });

  try {
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (getVideoId(tab?.url)) {
      title.textContent = (tab.title ?? "Видео YouTube").replace(/\s*[-–] YouTube$/, "");
      extract.disabled = false;
      setStatus("Нажмите «Получить текст».");
    } else {
      setStatus("Откройте обычную страницу видео на youtube.com. Shorts пока не поддерживаются.", "error");
    }
  } catch {
    setStatus("Не удалось определить вкладку. Откройте видео и запустите расширение снова.", "error");
  }
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.scripting?.executeScript) {
  initializePopup(document, chrome, navigator.clipboard);
}
