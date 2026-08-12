#!/usr/bin/env node
// One-shot: erase TypeScript syntax in place, .ts -> .js, rewriting nothing else.
// ts-blank-space replaces type syntax with spaces, so line numbers, comments and
// formatting survive. `standard --fix` then removes the leftover whitespace.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import tsBlankSpace from "ts-blank-space";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/strip-types.mjs <file.ts> [...]");
  process.exit(1);
}

for (const file of files) {
  if (!file.endsWith(".ts")) { console.error(`skip (not .ts): ${file}`); continue; }
  const src = readFileSync(file, "utf8");
  const out = tsBlankSpace(src, (node) => {
    console.error(`[strip] UNERASABLE construct in ${file} at pos ${node.pos}: kind ${node.kind}`);
    process.exitCode = 1;
  });
  const target = file.replace(/\.ts$/, ".js");
  writeFileSync(target, out);
  unlinkSync(file);
  console.error(`[strip] ${file} -> ${target}`);
}
