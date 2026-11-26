import { copyFileSync, writeFileSync } from 'node:fs';

const revision = process.env.BUILD_REVISION || null;
const timestamp = process.env.BUILD_TIMESTAMP || null;
const builtAt = timestamp?.length === 20 ? timestamp.replace(/Z$/, '.000Z') : timestamp;
const runUrl = process.env.BUILD_RUN_URL || null;

if (revision && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error('BUILD_REVISION must be a full commit SHA.');
}
if (timestamp && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== builtAt)) {
  throw new Error('BUILD_TIMESTAMP must be a UTC timestamp.');
}
if (runUrl && !/^https:\/\/github\.com\/arolariu\/software-factory\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/.test(runUrl)) {
  throw new Error('BUILD_RUN_URL must be an exact Software Factory Actions run URL.');
}

copyFileSync(
  new URL('../src/server/persistence/001-foundation.sql', import.meta.url),
  new URL('../dist/server/persistence/001-foundation.sql', import.meta.url),
);
writeFileSync(new URL('../dist/build.json', import.meta.url), JSON.stringify({
  revision,
  builtAt,
  runUrl,
}) + '\n');
