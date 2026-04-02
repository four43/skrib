#!/usr/bin/env node

/**
 * Generates data/emoji.json from the unicode-emoji-json package.
 *
 * Run:  node generate-emoji-data.js
 * Deps: npm install --save-dev unicode-emoji-json
 *
 * The output format matches what the emoji picker plugin expects:
 *   { emoji, name, keywords, category }
 *
 * Skin-tone variants are excluded — only default (yellow) emojis are included.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dataByEmoji = JSON.parse(
  readFileSync(
    join(__dirname, "node_modules/unicode-emoji-json/data-by-emoji.json"),
    "utf-8",
  ),
);

// Map unicode-emoji-json group names to the category ids used in the picker.
const GROUP_TO_CATEGORY = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "animals",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
};

/**
 * Turn an emoji name like "grinning face with smiling eyes"
 * into useful search keywords: ["grinning", "smiling", "eyes"].
 * Drops common filler words so searches stay relevant.
 */
function nameToKeywords(name) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "but",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  return name
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

const emojis = [];

for (const [char, info] of Object.entries(dataByEmoji)) {
  const category = GROUP_TO_CATEGORY[info.group];
  if (!category) {
    console.warn(`Unknown group "${info.group}" for ${char} — skipping`);
    continue;
  }

  emojis.push({
    emoji: char,
    name: info.name.toLowerCase().replace(/\s+/g, "-"),
    keywords: nameToKeywords(info.name),
    category,
  });
}

const outPath = join(__dirname, "data/emoji.json");
writeFileSync(outPath, JSON.stringify(emojis, null, 2) + "\n");
console.log(`Wrote ${emojis.length} emojis to ${outPath}`);
