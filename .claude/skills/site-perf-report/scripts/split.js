#!/usr/bin/env node
// Split a groups file into chunks so each audit.js call fits a command's time limit.
// Usage: node split.js groups.json --size 1 --prefix /tmp/g-
// Writes /tmp/g-0.json, /tmp/g-1.json, ... and prints their paths, one per line.
//
// Everything other than `groups` (site, origin, drift, configApplied) is copied
// into every chunk, so it survives into the audit output and the final run.

const fs = require("fs");

const args = process.argv.slice(2);
const input = args.find((a, i) => !a.startsWith("--") && !["--size", "--prefix"].includes(args[i - 1]));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const SIZE = Math.max(1, parseInt(getFlag("size", "1"), 10));
const PREFIX = getFlag("prefix", "/tmp/g-");

if (!input) {
  console.error("usage: node split.js groups.json --size 1 --prefix /tmp/g-");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(input, "utf8"));
const paths = [];
for (let i = 0, n = 0; i < data.groups.length; i += SIZE, n++) {
  const chunk = Object.assign({}, data, { groups: data.groups.slice(i, i + SIZE) });
  chunk.groupCount = chunk.groups.length;
  const p = `${PREFIX}${n}.json`;
  fs.writeFileSync(p, JSON.stringify(chunk));
  paths.push(p);
}
console.log(paths.join("\n"));
