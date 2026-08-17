import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPending } from '../src/actions/upgradeApps.js';

// Real `midclt call app.query '[]'` output from the GPU server, 2026-08-17.
// Every app happened to be current at that moment — which is the case the
// action must survive, because the button is gated on Ollama's flag and a
// race (someone updating from the TrueNAS UI) can empty the list mid-click.
const ALL_CURRENT = [
  { name: 'ollama',               upgrade_available: false, image_updates_available: false },
  { name: 'cloudflared',          upgrade_available: false, image_updates_available: false },
  { name: 'whisper-asr-faster',   upgrade_available: false, image_updates_available: false },
  { name: 'portainer',            upgrade_available: false, image_updates_available: false },
  { name: 'open-webui',           upgrade_available: false, image_updates_available: false },
  { name: 'speaches',             upgrade_available: false, image_updates_available: false },
  { name: 'whisper-asr-whisperx', upgrade_available: false, image_updates_available: false },
];

test('an all-current install yields nothing to upgrade', () => {
  assert.deepEqual(selectPending(ALL_CURRENT), { charts: [], images: [] });
});

test('a chart version bump goes to app.upgrade_bulk', () => {
  const apps = [
    { name: 'ollama',    upgrade_available: true,  image_updates_available: false },
    { name: 'portainer', upgrade_available: false, image_updates_available: false },
  ];
  assert.deepEqual(selectPending(apps), { charts: ['ollama'], images: [] });
});

test('a fresher image on the same chart goes to app.pull_images', () => {
  const apps = [
    { name: 'ollama',    upgrade_available: false, image_updates_available: true },
    { name: 'portainer', upgrade_available: false, image_updates_available: false },
  ];
  assert.deepEqual(selectPending(apps), { charts: [], images: ['ollama'] });
});

test('an app flagged both ways is upgraded once, as a chart', () => {
  // app.upgrade pulls the new images as part of the chart bump, so listing it
  // in both buckets would redeploy it a second time for nothing.
  const apps = [{ name: 'ollama', upgrade_available: true, image_updates_available: true }];
  assert.deepEqual(selectPending(apps), { charts: ['ollama'], images: [] });
});

test('the two buckets are filled independently across apps', () => {
  const apps = [
    { name: 'ollama',      upgrade_available: true,  image_updates_available: true  },
    { name: 'cloudflared', upgrade_available: false, image_updates_available: true  },
    { name: 'portainer',   upgrade_available: true,  image_updates_available: false },
    { name: 'speaches',    upgrade_available: false, image_updates_available: false },
  ];
  assert.deepEqual(selectPending(apps), {
    charts: ['ollama', 'portainer'],
    images: ['cloudflared'],
  });
});

test('missing flags are treated as no update, not as truthy objects', () => {
  // app.query with a narrow `select` omits keys entirely rather than
  // returning them as false — undefined must not read as "needs upgrade".
  const apps = [{ name: 'ollama' }];
  assert.deepEqual(selectPending(apps), { charts: [], images: [] });
});
