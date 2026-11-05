import App from './App.svelte';

export function createInstance(): {destroy(): void} {
  return {destroy: () => undefined};
}

export {App};
