import { mount } from 'svelte';
import AppShell from './AppShell.svelte';

const target = document.getElementById('app');
if (target) mount(AppShell, { target });
