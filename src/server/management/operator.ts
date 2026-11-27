import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasCurrentSchema } from '../persistence/migrations.js';
import { openDatabase } from '../persistence/open.js';
import { assertManagementData, managementOrigin } from './runtime.js';

export function issueOperatorCode(dataDir: string, origin: string, terminal: boolean) {
  if (!terminal) throw new Error('Setup codes require an interactive operator terminal.');
  managementOrigin(origin);
  const file = join(dataDir, 'factory.sqlite');
  if (!existsSync(file)) throw new Error('Start the Factory instance before issuing a setup code.');
  const db = openDatabase(file);
  try {
    if (!hasCurrentSchema(db)) throw new Error('Start the current Factory image before issuing a setup code.');
    return assertManagementData(db).issueCode();
  } finally {
    db.close();
  }
}
