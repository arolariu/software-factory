import { onMount } from 'svelte';
import type { ApiDto } from '../shared/api/schemas.js';
import { accessProblem, readPortal, requestVersion } from './portal-read.js';

export function readReport<K extends 'activeSessions' | 'statistics'>(
  path: string, unavailable: string, onRefresh?: () => void,
) {
  const controller = new AbortController();
  const version = requestVersion();
  let data = $state<ApiDto<K>>();
  let checkedAt = $state('');
  let notice = $state('');
  let pending = $state(true);
  let needsSync = $state(false);

  function clearAccess(error: unknown) {
    const problem = accessProblem(error);
    if (!problem) return false;
    version.next();
    data = undefined;
    checkedAt = '';
    pending = false;
    needsSync = problem === 'ACCESS_UNVERIFIED';
    notice = needsSync ? 'Repository access could not be verified. Open Repositories and run Sync.'
      : 'Access to this view is no longer authorized. Check your sign-in and repository connections.';
    onRefresh?.();
    return true;
  }

  async function refresh() {
    const ticket = version.next();
    pending = true;
    notice = '';
    needsSync = false;
    onRefresh?.();
    try {
      const current = await readPortal<ApiDto<K>>(path, controller.signal);
      if (version.current(ticket)) {
        data = current;
        checkedAt = new Date().toISOString();
      }
    } catch (error) {
      if (!clearAccess(error) && version.current(ticket)) {
        notice = data ? 'Showing the last successful read. Refresh to retry.' : unavailable;
      }
    } finally { if (version.current(ticket)) pending = false; }
  }

  onMount(() => {
    void refresh();
    return () => controller.abort();
  });
  return {
    get data() { return data; },
    get checkedAt() { return checkedAt; },
    get notice() { return notice; },
    get pending() { return pending; },
    get needsSync() { return needsSync; },
    signal: controller.signal, refresh, clearAccess,
  };
}
