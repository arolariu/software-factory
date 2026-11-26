import { mount } from 'svelte';
import AppShell from './AppShell.svelte';

export function mountPortal(target: HTMLElement | null) {
  if (target) return mount(AppShell, { target });
}

mountPortal(document.getElementById('app'));
