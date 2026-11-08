export function getVideoId(value) {
  try {
    const url = new URL(value);
    const videoId = url.searchParams.get("v");
    return url.protocol === "https:"
      && ["youtube.com", "www.youtube.com"].includes(url.hostname)
      && url.pathname === "/watch"
      && /^[a-zA-Z0-9_-]{11}$/.test(videoId ?? "")
      ? videoId : null;
  } catch {
    return null;
  }
}

export function formatTranscript(segments, includeTimestamps = false) {
  return segments.map(({ text, timestamp }) => (
    includeTimestamps && timestamp ? `[${timestamp}] ${text}` : text
  )).join("\n");
}

export function createDownloadName(title, videoId) {
  const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 100).replace(/[. ]+$/g, "");
  return `${safeTitle || "YouTube"} — ${videoId}.txt`;
}
