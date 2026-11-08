import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadName, formatTranscript, getVideoId } from "../transcript.js";

test("accepts desktop watch URLs and ignores playlist and timestamp parameters", () => {
  assert.equal(getVideoId("https://www.youtube.com/watch?v=abcdefghijk&list=PL123&t=60"), "abcdefghijk");
  assert.equal(getVideoId("https://youtube.com/watch?v=abc-def_123"), "abc-def_123");
});

test("rejects other websites, mobile URLs, Shorts and invalid video IDs", () => {
  for (const url of [
    "https://www.youtube.com.evil.example/watch?v=abcdefghijk",
    "https://example.com/watch?v=abcdefghijk",
    "https://m.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/shorts/abcdefghijk",
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch",
    undefined,
  ]) {
    assert.equal(getVideoId(url), null, String(url));
  }
});

test("formats timestamps without removing legitimate repeated lines", () => {
  const rows = [
    { timestamp: "0:00", text: "Привет" },
    { timestamp: "1:02:03", text: "Привет" },
    { timestamp: "", text: "Строка без таймкода" },
  ];
  assert.equal(formatTranscript(rows), "Привет\nПривет\nСтрока без таймкода");
  assert.equal(formatTranscript(rows, true), "[0:00] Привет\n[1:02:03] Привет\nСтрока без таймкода");
});

test("creates a usable TXT filename while preserving Russian titles", () => {
  assert.equal(createDownloadName('Урок: "JavaScript" / ввод?\n', "abcdefghijk"), "Урок JavaScript ввод — abcdefghijk.txt");
  assert.equal(createDownloadName("...", "abcdefghijk"), "YouTube — abcdefghijk.txt");
  assert.ok(createDownloadName("а".repeat(200), "abcdefghijk").length < 130);
});
