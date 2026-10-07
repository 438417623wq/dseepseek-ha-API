/**
 * Pre-flight check for the profile mount.
 *
 * DSH's boot is all-or-nothing: the loader dies on the first bundle it cannot
 * resolve, and client-modules throws during activation when a package declares
 * `dsh.client` without a loadable `./client` export. Either failure means the
 * desktop window does not open at all. This script reproduces both checks
 * offline, so a bad mount is caught here instead of at the next launch.
 *
 * Run: node verify-mount.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".dsh", "profiles", "desktop");
const PACKAGE = "dsh-model-bridge";
/**
 * Bundles the desktop app itself supplies from app.asar, so they are expected to
 * be absent from the profile's own node_modules.
 */
const APP_SUPPLIED = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);

let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : `\n         ${detail}`}`);
  }
};

console.log(`profile: ${PROFILE_DIR}\n`);

// ── the manifest ────────────────────────────────────────────────────────────
console.log("== profile manifest ==");

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
  check("package.json parses", true);
} catch (error) {
  check("package.json parses", false, String(error.message));
  process.exit(1);
}

const bundles = manifest.dsh?.profile?.bundles ?? [];
check(`${PACKAGE} is listed in dsh.profile.bundles`, bundles.includes(PACKAGE), JSON.stringify(bundles));
check(`${PACKAGE} is declared in dependencies`, manifest.dependencies?.[PACKAGE] !== undefined, JSON.stringify(manifest.dependencies?.[PACKAGE]));

// ── every bundle resolves ───────────────────────────────────────────────────
console.log("\n== bundle resolution ==");

for (const name of bundles) {
  if (APP_SUPPLIED.has(name)) {
    console.log(`  ok   ${name} (supplied by the app)`);
    continue;
  }
  check(`${name} resolves in the profile`, existsSync(join(PROFILE_DIR, "node_modules", name, "package.json")));
}

// ── the client-modules contract ─────────────────────────────────────────────
console.log("\n== client-modules contract ==");

const pkgDir = join(PROFILE_DIR, "node_modules", PACKAGE);
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  check("the installed package.json parses", true);
} catch (error) {
  check("the installed package.json parses", false, String(error.message));
  process.exit(1);
}

const decl = pkg.dsh?.client;
if (decl?.platform === "web") {
  // This is the throw that kills the boot: platform "web" without a client export.
  const rel = typeof pkg.exports?.["./client"] === "string"
    ? pkg.exports["./client"]
    : pkg.exports?.["./client"]?.default;
  check('dsh.client.platform === "web" declares exports["./client"]', typeof rel === "string", JSON.stringify(pkg.exports));
  if (typeof rel === "string") {
    check("the declared client bundle exists on disk", existsSync(join(pkgDir, rel)), join(pkgDir, rel));
  }
} else {
  console.log(`  ok   dsh.client is ${decl === undefined ? "absent" : `platform "${decl.platform}"`}; no client bundle required`);
}

// ── the bundle patch ────────────────────────────────────────────────────────
console.log("\n== bundle patch ==");

const patchRel = pkg.dsh?.bundle?.patch;
check("the package declares a bundle patch", typeof patchRel === "string", JSON.stringify(pkg.dsh?.bundle));
if (typeof patchRel === "string") {
  const patchPath = join(pkgDir, patchRel);
  check("the patch file exists", existsSync(patchPath), patchPath);
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, "utf8");
    check("the patch inserts a row for this package", patch.includes(PACKAGE), patch.trim().slice(0, 160));
  }
}

// ── the host entry ──────────────────────────────────────────────────────────
console.log("\n== host entry ==");

const mainRel = pkg.main ?? "index.js";
check(`the entry point exists (${mainRel})`, existsSync(join(pkgDir, mainRel)));

// ── the profile patch layer does not disable it ─────────────────────────────
console.log("\n== profile patch layer ==");

const profilePatch = join(PROFILE_DIR, "cordis.patch.yml");
if (existsSync(profilePatch)) {
  const text = readFileSync(profilePatch, "utf8");
  // A `disabled: true` targeting this plugin's loader id would silently keep the
  // gateway off even though the bundle is mounted.
  const disables = /- id:\s*model-bridge[\s\S]{0,200}?disabled:\s*true/u.test(text);
  check("the profile patch does not disable the plugin", !disables, "found a `disabled: true` row for id model-bridge");
} else {
  console.log("  ok   no profile patch layer (nothing to disable it)");
}

console.log(`\n${"=".repeat(60)}`);
if (failed === 0) {
  console.log("PRE-FLIGHT: PASS — the profile can compose this bundle.");
  console.log("Restart DSH, then run: node check-live.mjs");
} else {
  console.log(`PRE-FLIGHT: ${failed} FAILURE(S) — do not restart until these are fixed.`);
}
process.exit(failed === 0 ? 0 : 1);
