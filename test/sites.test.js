import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTopSites, sameSites, siteLabel, siteText, validAccent, dominantColour } from '../lib/sites.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('labels strip www.', () => {
  assert.equal(siteLabel('www.github.com'), 'github.com');
  assert.equal(siteLabel('mail.google.com'), 'mail.google.com');
});

test('keeps http(s) only, one per host, in order', () => {
  const out = normaliseTopSites([
    { url: 'https://www.github.com/chiaxr', title: ' GitHub \n  repo ', favicon: PNG },
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'file:///etc/passwd', title: 'x' },
    { url: 'about:config', title: 'x' },
    { url: 'not a url' },
    { url: 'https://WWW.GITHUB.COM/other', title: 'dupe' },
    { url: 'http://example.com/', title: 42 },
    null,
  ]);
  assert.deepEqual(out, [
    { url: 'https://www.github.com/chiaxr', host: 'github.com', title: 'GitHub repo', favicon: PNG },
    { url: 'http://example.com/', host: 'example.com', title: '', favicon: null },
  ]);
});

test('chip text is the title, else the host', () => {
  assert.equal(siteText({ title: 'Inbox (3) - Gmail', host: 'mail.google.com' }), 'Inbox (3) - Gmail');
  assert.equal(siteText({ title: '', host: 'example.com' }), 'example.com');
});

test('favicons must be inline data:image URLs', () => {
  const fav = (favicon) => normaliseTopSites([{ url: 'https://a.com', favicon }])[0].favicon;
  assert.equal(fav(PNG), PNG);
  assert.equal(fav('data:image/svg+xml,%3Csvg%3E'), 'data:image/svg+xml,%3Csvg%3E');
  assert.equal(fav('https://a.com/favicon.ico'), null, 'remote URL would be a network call');
  assert.equal(fav('data:text/html,<b>'), null);
  assert.equal(fav(undefined), null);
});

test('limit and bad input', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i}.com/` }));
  assert.equal(normaliseTopSites(many).length, 12);
  assert.equal(normaliseTopSites(many, 3).length, 3);
  assert.deepEqual(normaliseTopSites(undefined), []);
});

test('validAccent', () => {
  assert.equal(validAccent('#ea4335'), '#ea4335');
  assert.equal(validAccent('red'), null);
  assert.equal(validAccent('#fff'), null);
  assert.equal(validAccent('#ea4335; background:url(x)'), null);
  assert.equal(validAccent(undefined), null);
});

/** RGBA pixel array from [[r,g,b,a], count] runs. */
const pixels = (...runs) => runs.flatMap(([rgba, n]) => Array.from({ length: n }, () => rgba)).flat();

test('dominantColour picks the main hue', () => {
  // Gmail-ish: mostly red with some blue and white.
  assert.equal(dominantColour(pixels([[234, 67, 53, 255], 60], [[66, 133, 244, 255], 30], [[255, 255, 255, 255], 40])), '#ea4335');
  // Transparent pixels don't count.
  assert.equal(dominantColour(pixels([[0, 0, 0, 0], 200], [[255, 102, 0, 255], 20])), '#ff6600');
});

test('dominantColour averages within the winning bucket (weighted by saturation)', () => {
  assert.equal(dominantColour(pixels([[200, 0, 0, 255], 10], [[220, 20, 20, 255], 10])), '#d10909');
});

test('dominantColour is null for neutral icons', () => {
  assert.equal(dominantColour(pixels([[0, 0, 0, 255], 100], [[255, 255, 255, 255], 100])), null, 'black/white logo');
  assert.equal(dominantColour(pixels([[128, 128, 128, 255], 100])), null, 'grey');
  assert.equal(dominantColour(pixels([[0, 0, 0, 255], 196], [[255, 0, 0, 255], 4])), null, 'a speck of colour');
  assert.equal(dominantColour(pixels([[0, 0, 0, 0], 50])), null, 'fully transparent');
  assert.equal(dominantColour([]), null);
});

test('sameSites', () => {
  const a = normaliseTopSites([{ url: 'https://a.com', title: 'A' }]);
  assert.ok(sameSites(a, normaliseTopSites([{ url: 'https://a.com', title: 'A' }])));
  assert.ok(!sameSites(a, normaliseTopSites([{ url: 'https://a.com', title: 'B' }])));
  assert.ok(!sameSites(a, [{ ...a[0], accent: '#ff0000' }]), 'accent change counts');
  assert.ok(!sameSites(a, undefined));
});
