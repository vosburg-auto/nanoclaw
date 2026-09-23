#!/usr/bin/env node
// Fork guard: every job in the upstream-infrastructure workflows must be gated
// to the upstream repo, so they don't fail on every fork PR. Exits 1 if any job
// lacks the gate (e.g. a sync took upstream's copy wholesale).
import fs from 'node:fs';

const GATE = "github.repository == 'nanocoai/nanoclaw'";
const FILES = ['registry-skills', 'verify-agent-image', 'approve-agent-image', 'refresh-agent-image', 'release'].map(
  (f) => `.github/workflows/${f}.yml`,
);

let bad = 0;
for (const file of FILES) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('jobs:'));
  let job = null;
  let gated = false;
  const finish = () => {
    if (job && !gated) {
      console.error(`${file}: job '${job}' is not gated on ${GATE}`);
      bad++;
    }
  };
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      finish();
      job = m[1];
      gated = false;
    } else if (/^    if:/.test(l) && l.includes(GATE)) gated = true;
  }
  finish();
}
if (bad) process.exit(1);
console.log(`upstream-workflow gates: OK (${FILES.length} files)`);
