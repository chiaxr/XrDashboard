#!/usr/bin/env node
// Release a self-updating version:
//   npm run release            release the version already in manifest.json
//   npm run release -- 1.0.4   bump manifest.json to 1.0.4 first (committed)
//
// Steps: checks → test + lint → push main → sign (AMO, unlisted) → GitHub release with the
// .xpi → add it to updates.json on main. Firefox reads updates.json via the manifest's
// update_url (about once a day) and installs the new version by itself.
// Safe to re-run after a failure: an already-signed .xpi or existing release is reused.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const REPO = 'chiaxr/XrDashboard';
const BRANCH = 'main';
const UPDATE_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/updates.json`;
const ARTIFACTS = 'web-ext-artifacts';
const KEEP_VERSIONS = 5;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const step = (msg) => console.log(`\n→ ${msg}`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

// ── checks ───────────────────────────────────────────────────────────────
if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== BRANCH) fail(`Switch to ${BRANCH} first.`);
if (out('git', ['status', '--porcelain'])) fail('Working tree has uncommitted changes. Commit or stash them first.');

let manifest = readJson('manifest.json');
const gecko = manifest.browser_specific_settings?.gecko || {};
if (gecko.update_url !== UPDATE_URL) fail(`manifest.json gecko.update_url must be ${UPDATE_URL}`);

const bump = process.argv[2];
if (bump) {
  if (!/^\d+(\.\d+){1,3}$/.test(bump)) fail(`"${bump}" is not a version like 1.0.4`);
  if (cmpVersion(bump, manifest.version) <= 0) fail(`${bump} is not newer than ${manifest.version}`);
  step(`Bumping version ${manifest.version} → ${bump}`);
  manifest = { ...manifest, version: bump };
  writeJson('manifest.json', manifest);
  run('git', ['commit', '-q', '-m', `Bump version to ${bump}`, 'manifest.json']);
}
const version = manifest.version;
const tag = `v${version}`;

const released = existsSync('updates.json')
  ? (readJson('updates.json').addons?.[gecko.id]?.updates || []).map((u) => u.version)
  : [];
if (released.includes(version)) fail(`${version} is already in updates.json. Bump the version: npm run release -- <new version>`);

// ── test, lint, push ─────────────────────────────────────────────────────
step('Tests');
run('npm', ['test', '--silent']);
step('Lint');
run('npx', ['--yes', 'web-ext@10', 'lint', '--self-hosted']);
step(`Pushing ${BRANCH}`);
run('git', ['push', 'origin', BRANCH]);

// ── sign ─────────────────────────────────────────────────────────────────
const findXpi = () => existsSync(ARTIFACTS)
  && readdirSync(ARTIFACTS).find((f) => f.endsWith(`-${version}.xpi`) && !f.startsWith('newtab-dashboard-'));
if (findXpi()) {
  step(`Reusing signed ${ARTIFACTS}/${findXpi()}`);
} else {
  step('Signing with AMO (unlisted); this can take a few minutes');
  run('npm', ['run', 'sign', '--silent']);
}
const signed = findXpi();
if (!signed) fail(`No signed .xpi for ${version} in ${ARTIFACTS}/`);
const asset = `${ARTIFACTS}/newtab-dashboard-${version}.xpi`;
copyFileSync(`${ARTIFACTS}/${signed}`, asset);
const hash = `sha256:${createHash('sha256').update(readFileSync(asset)).digest('hex')}`;

// ── GitHub release ───────────────────────────────────────────────────────
let exists = true;
try { out('gh', ['release', 'view', tag, '--repo', REPO]); } catch { exists = false; }
if (exists) {
  step(`Release ${tag} exists; replacing its .xpi`);
  run('gh', ['release', 'upload', tag, asset, '--clobber', '--repo', REPO]);
} else {
  step(`Creating GitHub release ${tag}`);
  run('gh', ['release', 'create', tag, asset, '--repo', REPO, '--target', BRANCH, '--title', tag,
    '--notes', 'Signed (unlisted) build. Installed copies update themselves via updates.json.']);
}
const link = `https://github.com/${REPO}/releases/download/${tag}/newtab-dashboard-${version}.xpi`;
const res = await fetch(link, { method: 'HEAD', redirect: 'follow' });
if (!res.ok) fail(`Release asset not reachable (HTTP ${res.status}): ${link}`);

// ── updates.json ─────────────────────────────────────────────────────────
step('Publishing updates.json');
const doc = existsSync('updates.json') ? readJson('updates.json') : { addons: {} };
const updates = (doc.addons?.[gecko.id]?.updates || []).filter((u) => u.version !== version);
updates.push({
  version,
  update_link: link,
  update_hash: hash,
  ...(gecko.strict_min_version ? { browser_specific_settings: { gecko: { strict_min_version: gecko.strict_min_version } } } : {}),
});
updates.sort((a, b) => cmpVersion(b.version, a.version));
writeJson('updates.json', { addons: { [gecko.id]: { updates: updates.slice(0, KEEP_VERSIONS) } } });
run('git', ['add', 'updates.json']);
run('git', ['commit', '-q', '-m', `Release ${tag}`]);
run('git', ['push', 'origin', BRANCH]);
run('git', ['fetch', '-q', '--tags', 'origin']);

console.log(`\n✓ Released ${version}\n  ${link}\n  Installed copies pick it up within a day, or now via about:addons → ⚙ → Check for Updates.`);
