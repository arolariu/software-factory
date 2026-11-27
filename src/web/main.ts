import { mount } from 'svelte';
import AppShell from './AppShell.svelte';

export function mountPortal(target: HTMLElement | null) {
  return target ? mount(AppShell, { target }) : undefined;
}

mountPortal(document.getElementById('app'));
