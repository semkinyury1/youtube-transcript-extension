import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { readYouTubeTranscript } from "../extractor.js";
import { downloadTranscript } from "../download.js";
import { createDownloadName, formatTranscript, getVideoId } from "../transcript.js";
import { installTranscriptPanel } from "../panel.js";

const source = new URL("../", import.meta.url);
const destination = new URL("../dist/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const file of ["manifest.json", "popup.html", "popup.css", "popup.js", "extractor.js", "transcript.js", "download.js"]) {
  await copyFile(new URL(file, source), new URL(file, destination));
}
// Registered content scripts are classic scripts, so bundle functions without imports.
const functions = [getVideoId, formatTranscript, createDownloadName, downloadTranscript, readYouTubeTranscript, installTranscriptPanel];
await writeFile(new URL("content-script.js", destination),
  `(() => {\n${functions.map((fn) => fn.toString()).join("\n\n")}\ninstallTranscriptPanel(document);\n})();\n`);
console.log("Готовое расширение: dist/");
