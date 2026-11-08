// executeScript serializes this function without its module imports.
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

  const panelSelector = "ytd-engagement-panel-section-list-renderer";
  const transcriptSelector = "ytd-transcript-renderer, transcript-segment-list-view-model, transcript-segment-view-model";
  const isHidden = (element) => Boolean(element?.closest(`[hidden], ${panelSelector}[visibility*="HIDDEN"]`));

  function isCurrentPage() {
    const currentUrl = new URL(window.location.href);
    return currentUrl.origin === pageUrl.origin && currentUrl.pathname === "/watch"
      && currentUrl.searchParams.get("v") === videoId;
  }

  function findCurrentWatchPage() {
    const watchPage = document.querySelector("ytd-watch-flexy");
    const currentVideoId = watchPage?.getAttribute("video-id");
    if (currentVideoId && currentVideoId !== videoId) return null;
    return watchPage;
  }

  let finishBackgroundLoading;
  function startBackgroundLoading() {
    const existingVisiblePanels = new Set(Array.from(document.querySelectorAll(panelSelector))
      .filter((panel) => !isHidden(panel)));
    const backgroundPanels = new Set();
    const attribute = `data-yte-background-${Math.random().toString(36).slice(2)}`;
    const style = document.createElement("style");
    // Keep the panel measurable so YouTube renders its rows.
    style.textContent = `[${attribute}] {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 400px !important; height: 80vh !important;
      visibility: hidden !important; pointer-events: none !important;
    }
    [${attribute}] * { visibility: hidden !important; }`;
    (document.head ?? document.documentElement).append(style);

    const hideAutomaticPanels = () => {
      if (!isCurrentPage() || !findCurrentWatchPage()) return;
      for (const panel of document.querySelectorAll(panelSelector)) {
        if (existingVisiblePanels.has(panel)) continue;
        const target = panel.getAttribute("target-id");
        // New transcript panels may not have a target-id.
        if (target && target !== "engagement-panel-searchable-transcript"
            && target !== "PAmodern_transcript_view" && !panel.querySelector(transcriptSelector)) continue;
        if (!backgroundPanels.has(panel)) {
          backgroundPanels.add(panel);
          panel.setAttribute(attribute, "");
        }
      }
    };
    // Hide new panels before the browser paints them.
    const observer = new MutationObserver(hideAutomaticPanels);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["visibility", "target-id"],
    });
    hideAutomaticPanels();

    finishBackgroundLoading = () => {
      hideAutomaticPanels();
      observer.disconnect();
      try {
        // YouTube may reuse this panel for the next video.
        if (!isCurrentPage() || !findCurrentWatchPage()) return;
        for (const panel of backgroundPanels) {
          if (!panel.isConnected || isHidden(panel)) continue;
          const close = panel.querySelector("#visibility-button button, #visibility-button [role='button']")
            ?? panel.querySelector("#visibility-button");
          close?.click();
          if (!isHidden(panel)) {
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
    // Some layouts mount the transcript outside watch-flexy.
    const panels = Array.from(document.querySelectorAll(panelSelector))
      .filter((panel) => !isHidden(panel) && panel.querySelector(transcriptSelector));
    const expandedPanel = panels.find((panel) => panel.getAttribute("visibility")?.includes("EXPANDED"));
    return expandedPanel ?? panels[0] ?? Array.from(watchPage.querySelectorAll("ytd-transcript-renderer"))
      .find((renderer) => !isHidden(renderer));
  }

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) return fail("CANCELLED", "Загрузка отменена.");
      if (!isCurrentPage()) {
        return fail("VIDEO_CHANGED", "Видео сменилось во время загрузки. Нажмите «Получить текст» ещё раз.");
      }

      const watchPage = findCurrentWatchPage();
      if (!watchPage) {
        lastSignature = "";
        await pause();
        continue;
      }

      const transcript = findTranscriptRoot(watchPage);
      const rows = Array.from(transcript?.querySelectorAll(
        "ytd-transcript-segment-renderer, transcript-segment-view-model",
      ) ?? []).filter((row) => !isHidden(row));
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
            || normalize(document.title.replace(/\s*[-\u2013] YouTube$/, "")) || "Видео YouTube";
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
    if (!findCurrentWatchPage()) {
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
