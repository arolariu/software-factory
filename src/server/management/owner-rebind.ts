import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createGitHubDeviceFlow, githubDeviceApproval } from '../identity/device-flow.js';
import { createRegistry, type Registration } from '../identity/github-hosts.js';
import { createOAuthTransport } from '../identity/oauth.js';
import { hasCurrentSchema } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { createSetupStore } from './setup.js';

type Approve = (registration: Registration, showCode: (code: string) => void) => Promise<string>;

async function approveGitHubAccount(registration: Registration, showCode: (code: string) => void) {
  const device = createGitHubDeviceFlow();
  const flow = await device.start(registration.clientId);
  showCode(flow.userCode);
  let interval = flow.intervalMs;
  while (Date.now() + interval < flow.expiresAt) {
    await wait(interval);
    if (Date.now() >= flow.expiresAt) break;
    const result = await device.poll(registration.clientId, flow.deviceCode);
    if (result.kind === 'authorized') {
      return (await createOAuthTransport().verifyIdentity(registration, result.tokens, null)).subject;
    }
    if (result.kind === 'denied') throw new Error('GitHub denied replacement authorization.');
    if (result.kind === 'expired') break;
    if (result.kind === 'slow_down') interval += 5_000;
  }
  throw new Error('Replacement approval expired.');
}

function registration(clientId: string) {
  return createRegistry([{ hostname: 'github.com', label: 'GitHub', deviceClientId: clientId }])
    .registration('github.com', 'portal');
}

export async function rebindManagedOwner(
  dataDir: string, origin: string, currentId: string | undefined, candidateId: string | undefined,
  interactive: boolean, show: (message: string) => void, approve: Approve = approveGitHubAccount,
) {
  if (!interactive) throw new Error('Owner rebind requires an interactive operator terminal.');
  if (URL.parse(origin)?.origin !== origin || !origin.startsWith('https://')) {
    throw new Error('Owner rebind requires a canonical HTTPS public origin.');
  }
  if (!currentId || !candidateId || candidateId === currentId || !/^[A-Za-z0-9._-]+$/.test(candidateId)) {
    throw new Error('Supply the current and a different replacement public GitHub App Client ID.');
  }
  const file = join(dataDir, 'factory.sqlite');
  if (!existsSync(file)) throw new Error('Use an existing, stopped Factory data directory.');
  const db = openDatabase(file);
  try {
    if (!hasCurrentSchema(db)) throw new Error('Migrate the Factory database before rebinding.');
    const owner = createSetupStore(db).owner();
    if (!owner || owner.host !== 'github.com' || owner.registrationId !== registration(currentId).binding) {
      throw new Error('The current GitHub App must match the existing owner registration.');
    }
    const candidate = registration(candidateId);
    const subject = await approve(candidate, (code) => show(`Open ${githubDeviceApproval} and enter ${code}.`));
    if (subject !== owner.subject) throw new Error('The replacement GitHub App was not approved by the existing owner.');
    db.transaction(() => {
      const applied = db.prepare(`UPDATE management_owner SET registration_id=?
        WHERE singleton=1 AND provider=? AND host=? AND subject=? AND registration_id=?`)
        .run(candidate.binding, owner.provider, owner.host, owner.subject, owner.registrationId);
      if (applied.changes !== 1) throw new Error('The Factory owner changed while waiting for GitHub approval.');
      db.prepare('DELETE FROM portal_sessions WHERE registration_binding=?').run(owner.registrationId);
      db.prepare(`INSERT INTO management_audit (actor,action,occurred_at)
        SELECT user_id,'GITHUB_OWNER_REBOUND',? FROM identities WHERE provider=? AND issuer=? AND subject=?`)
        .run(Date.now(), owner.provider, `portal:${owner.host}`, owner.subject);
    }).immediate();
  } finally { db.close(); }
}
