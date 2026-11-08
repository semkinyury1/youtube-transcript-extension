import { createDownloadName, formatTranscript } from "./transcript.js";

export function downloadTranscript(doc, transcript, includeTimestamps = false) {
  const view = doc.defaultView;
  const text = formatTranscript(transcript.segments, includeTimestamps);
  const blob = new view.Blob(["\ufeff", text], { type: "text/plain;charset=utf-8" });
  const url = view.URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = createDownloadName(transcript.title, transcript.videoId);
  doc.body.append(link);
  link.click();
  link.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
}
