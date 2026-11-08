// Chrome serializes this function into the tab. Keep its helpers inside it.
export async function readYouTubeTranscript({
  timeoutMs = 12000,
  pollIntervalMs = 150,
  settleMs = 600,
  signal,
} = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  const pageUrl = new URL(window.location.href);
  const videoId = pageUrl.searchParams.get("v");
  if (pageUrl.protocol !== "https:"
      || !["youtube.com", "www.youtube.com"].includes(pageUrl.hostname)
      || pageUrl.pathname !== "/watch"
      || !/^[a-zA-Z0-9_-]{11}$/.test(videoId ?? "")) {
    return fail("UNSUPPORTED_PAGE", "Откройте обычную страницу видео на youtube.com и попробуйте снова.");
  }

  const normalize = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const pause = () => new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  const deadline = Date.now() + timeoutMs;
  let expanded = false;
  let opened = false;
  let lastSignature = "";
  let stableSince = 0;
  let unreadableRows = false;

  const isHiddenPanel = (panel) => panel && (
    panel.closest("[hidden]") !== null
    || panel.getAttribute("visibility")?.includes("HIDDEN")
  );

  let finishBackgroundLoading;
  function startBackgroundLoading() {
    const panelSelector = "ytd-engagement-panel-section-list-renderer";
    const existingVisiblePanels = new Set(Array.from(document.querySelectorAll(panelSelector))
      .filter((panel) => !isHiddenPanel(panel)));
    const backgroundPanels = new Set();
    const attribute = `data-yte-background-${Math.random().toString(36).slice(2)}`;
    const style = document.createElement("style");
    // Keep a measurable viewport for YouTube's row rendering, without taking up
    // sidebar space or allowing its automatic scroll to move the page.
    style.textContent = `[${attribute}] {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 400px !important; height: 80vh !important;
      visibility: hidden !important; pointer-events: none !important;
    }
    [${attribute}] * { visibility: hidden !important; }`;
    (document.head ?? document.documentElement).append(style);

    const hideAutomaticPanels = () => {
      const currentUrl = new URL(window.location.href);
      if (currentUrl.origin !== pageUrl.origin || currentUrl.pathname !== "/watch"
          || currentUrl.searchParams.get("v") !== videoId) return;
      const currentVideoId = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
      if (currentVideoId && currentVideoId !== videoId) return;
      for (const panel of document.querySelectorAll(panelSelector)) {
        if (existingVisiblePanels.has(panel)) continue;
        const target = panel.getAttribute("target-id");
        // Modern panels have no target-id even while their rows are loading.
        if (target && target !== "engagement-panel-searchable-transcript"
            && target !== "PAmodern_transcript_view" && !panel.querySelector(
          "ytd-transcript-renderer, transcript-segment-list-view-model, transcript-segment-view-model",
        )) continue;
        if (!backgroundPanels.has(panel)) {
          backgroundPanels.add(panel);
          panel.setAttribute(attribute, "");
        }
      }
    };
    // Mutation observers run before paint, including for asynchronously created
    // modern panels outside watch-flexy. Existing panels are hidden before click.
    const observer = new MutationObserver(hideAutomaticPanels);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["visibility", "target-id"],
    });
    hideAutomaticPanels();

    finishBackgroundLoading = () => {
      hideAutomaticPanels();
      observer.disconnect();
      try {
        const currentUrl = new URL(window.location.href);
        // Navigation can reuse the same native element for the next video.
        if (currentUrl.origin !== pageUrl.origin || currentUrl.pathname !== "/watch"
            || currentUrl.searchParams.get("v") !== videoId) return;
        const currentVideoId = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
        if (currentVideoId && currentVideoId !== videoId) return;
        for (const panel of backgroundPanels) {
          if (!panel.isConnected || isHiddenPanel(panel)) continue;
          const close = panel.querySelector("#visibility-button button, #visibility-button [role='button']")
            ?? panel.querySelector("#visibility-button");
          close?.click();
          // Some newer headers have no recognizable close button. Reflect the
          // hidden state on both the custom element and its visibility attribute.
          if (!isHiddenPanel(panel)) {
            if ("visibility" in panel) panel.visibility = "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN";
            panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
          }
        }
      } finally {
        for (const panel of backgroundPanels) panel.removeAttribute(attribute);
        style.remove();
      }
    };
  }

  function findTranscriptRoot(watchPage) {
    // Modern expanded panels can lack target-id and live outside watch-flexy.
    const panels = Array.from(document.querySelectorAll("ytd-engagement-panel-section-list-renderer"))
      .filter((panel) => !isHiddenPanel(panel) && panel.querySelector(
        "ytd-transcript-renderer, transcript-segment-list-view-model, transcript-segment-view-model",
      ));
    const expandedPanel = panels.find((panel) => panel.getAttribute("visibility")?.includes("EXPANDED"));
    return expandedPanel ?? panels[0] ?? Array.from(watchPage.querySelectorAll("ytd-transcript-renderer"))
      .find((renderer) => !isHiddenPanel(renderer.closest("ytd-engagement-panel-section-list-renderer")));
  }

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) return fail("CANCELLED", "Загрузка отменена.");
      const currentUrl = new URL(window.location.href);
      if (currentUrl.origin !== pageUrl.origin || currentUrl.pathname !== "/watch"
          || currentUrl.searchParams.get("v") !== videoId) {
        return fail("VIDEO_CHANGED", "Видео сменилось во время загрузки. Нажмите «Получить текст» ещё раз.");
      }

      const watchPage = document.querySelector("ytd-watch-flexy");
      if (!watchPage || (watchPage.getAttribute("video-id")
          && watchPage.getAttribute("video-id") !== videoId)) {
        lastSignature = "";
        await pause();
        continue;
      }

      const transcript = findTranscriptRoot(watchPage);
      const rows = Array.from(transcript?.querySelectorAll(
        "ytd-transcript-segment-renderer, transcript-segment-view-model",
      ) ?? []);
      const segments = rows
        .map((row) => ({
          text: normalize(row.querySelector(
            '.segment-text, .ytAttributedStringHost[role="text"], [role="text"], '
            + ".ytwTranscriptSegmentViewModelText, .ytTranscriptSegmentViewModelText, span.yt-core-attributed-string",
          )?.textContent),
          timestamp: normalize(row.querySelector(
            ".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp, .ytTranscriptSegmentViewModelTimestamp",
          )?.textContent)
            .replace(/[\u200e\u200f]/g, ""),
        }))
        .filter(({ text }) => text.length > 0);
      unreadableRows = rows.length > 0 && segments.length === 0;

      if (segments.length > 0 && !transcript.querySelector("tp-yt-paper-spinner[active]")) {
        const signature = JSON.stringify(segments);
        if (signature !== lastSignature) {
          lastSignature = signature;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= settleMs) {
          const title = normalize(watchPage.querySelector("ytd-watch-metadata h1")?.textContent)
            || normalize(document.title.replace(/\s*[-–] YouTube$/, "")) || "Видео YouTube";
          return {
            ok: true,
            transcript: {
              videoId,
              title,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              segments,
            },
          };
        }
        await pause();
        continue;
      }
      lastSignature = "";

      // Structural selectors work regardless of the YouTube interface language.
      if (!expanded) {
        const expand = watchPage.querySelector("#description-inline-expander #expand");
        if (expand) {
          expand.click();
          expanded = true;
        }
      }
      if (!opened && !transcript) {
        const button = watchPage.querySelector(
          "ytd-video-description-transcript-section-renderer button, "
          + 'ytd-video-description-transcript-section-renderer [role="button"]',
        );
        if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
          startBackgroundLoading();
          button.click();
          opened = true;
        }
      }
      await pause();
    }

    if (signal?.aborted) return fail("CANCELLED", "Загрузка отменена.");
    const watchPage = document.querySelector("ytd-watch-flexy");
    if (!watchPage || (watchPage.getAttribute("video-id")
        && watchPage.getAttribute("video-id") !== videoId)) {
      return fail("PAGE_NOT_READY", "Страница видео ещё не загрузилась. Дождитесь загрузки и попробуйте снова.");
    }
    if (unreadableRows) {
      return fail("TRANSCRIPT_FORMAT_UNSUPPORTED", "YouTube открыл расшифровку, но расширение не смогло прочитать её формат. Это ошибка совместимости с YouTube.");
    }
    return opened || lastSignature
      ? fail("TRANSCRIPT_TIMEOUT", "Не удалось дождаться расшифровки YouTube. Нажмите «Получить текст», чтобы повторить загрузку.")
      : fail("TRANSCRIPT_UNAVAILABLE", "Расшифровка недоступна: YouTube не показал её для этого видео. Распознавание звука в этой версии не поддерживается.");
  } finally {
    finishBackgroundLoading?.();
  }
}
