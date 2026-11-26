import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const location = pathToFileURL(`${process.cwd()}/dist/server/persistence/open.js`);
const { openDatabase } = await import(location.href) as typeof import('./open.js');
const db = openDatabase('/data/factory.sqlite');
try {
  switch (process.argv[2]) {
    case 'seed':
      db.exec(`
        INSERT INTO users(id) VALUES ('smoke-user');
        INSERT INTO identities(id, user_id, provider, issuer, subject)
          VALUES ('smoke-identity', 'smoke-user', 'github', 'github.com', '42');
        INSERT INTO repositories(id, provider, canonical_host, provider_scope, provider_repo_id, canonical_url)
          VALUES ('smoke-repo', 'github', 'github.com', 'test', '42', 'https://github.com/example/fixture');
        INSERT INTO repo_connections(id, repo_id, user_id, identity_id, connected_at)
          VALUES ('smoke-connection', 'smoke-repo', 'smoke-user', 'smoke-identity', 1);
      `);
      break;
    case 'check':
      assert.ok(db.prepare("SELECT 1 FROM repo_connections WHERE id = 'smoke-connection'").get());
      break;
    case 'backup':
      await db.backup('/backup/factory.sqlite');
      break;
    default:
      throw new Error('Expected seed, check, or backup.');
  }
} finally {
  db.close();
}
