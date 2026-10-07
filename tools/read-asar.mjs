/**
 * Read the real pi-ai adapter's chunk emission out of the packed app.asar, so
 * the gateway translates the vocabulary the host actually produces rather than
 * the one its documentation implies.
 *
 * app.asar is a simple archive: an 8-byte header (4-byte pickle size, 4-byte
 * header size), then a JSON directory, then the concatenated file bytes. That
 * is enough to extract one file without a dependency.
 *
 * Run: node read-asar.mjs <path-inside-asar> [path-to-app.asar]
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Locate app.asar without hard-coding one machine's layout.
 *
 * The archive sits next to the Electron executable in a packaged install, but
 * the drive letter and product folder differ per machine, so try the common
 * Windows locations and let the caller override.
 */
function findAsar() {
  const explicit = process.argv[3];
  if (explicit !== undefined) return explicit;
  const candidates = [
    "F:\\dsh-desktop\\resources\\app.asar",
    "C:\\Program Files\\DeepSeek Harness\\resources\\app.asar",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\DeepSeek Harness\\resources\\app.asar`,
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
    "/usr/lib/deepseek-harness/resources/app.asar",
  ].filter((path) => path.length > 0 && existsSync(path));
  if (candidates.length === 0) {
    console.error("could not find app.asar; pass its path as the second argument");
    process.exit(1);
  }
  return candidates[0];
}

const ASAR = findAsar();
const wanted = process.argv[2] ?? "\\dsh\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";

const buffer = readFileSync(ASAR);
const headerSize = buffer.readUInt32LE(12);
const headerJson = buffer.subarray(16, 16 + headerSize).toString("utf8");
const header = JSON.parse(headerJson);
const contentOffset = 16 + headerSize;

function walk(node, prefix) {
  const results = [];
  if (node.files === undefined) {
    return [{ path: prefix, size: node.size, offset: node.offset }];
  }
  for (const [name, child] of Object.entries(node.files)) {
    results.push(...walk(child, `${prefix}\\${name}`));
  }
  return results;
}

const all = walk(header, "");
console.log(`asar holds ${all.length} files`);

if (wanted === "--list-llm") {
  for (const entry of all.filter((e) => /dsh-llm[^\\]*\\lib\\index\.js$/.test(e.path))) {
    console.log(`  ${entry.path}  ${entry.size}`);
  }
  process.exit(0);
}

const entry = all.find((e) => e.path === wanted);
if (entry === undefined) {
  console.error(`not found: ${wanted}`);
  const near = all.filter((e) => e.path.includes("pi-ai")).slice(0, 20);
  for (const n of near) console.error(`  did you mean ${n.path}`);
  process.exit(1);
}

const file = buffer.subarray(contentOffset + Number(entry.offset), contentOffset + Number(entry.offset) + entry.size).toString("utf8");
console.log(`--- ${wanted} (${file.length} bytes) ---`);

// Print the regions that define the stream vocabulary.
const lines = file.split("\n");
const hits = [];
lines.forEach((line, index) => {
  if (/tool-call-delta|block-start|block-end|text-delta|reasoning-delta|"usage"|type: "finish"|blockType/.test(line)) {
    hits.push(index);
  }
});
const shown = new Set();
for (const index of hits) {
  for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i += 1) {
    if (shown.has(i)) continue;
    shown.add(i);
    console.log(`${String(i + 1).padStart(5)}: ${lines[i]}`);
  }
}
