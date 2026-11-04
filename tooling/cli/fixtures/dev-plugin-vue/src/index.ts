import App from './App.vue';

export function createInstance(): {destroy(): void} {
  return {destroy: () => undefined};
}

export {App};
