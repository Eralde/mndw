import '@mndw/sdk/tokens.css';
import {defineMndwUi} from '@mndw/ui';
import '@mndw/ui/styles.css';
import './styles/global.css';
import {firstValueFrom, timeout} from 'rxjs';
import {mount} from 'svelte';
import App from './App.svelte';
import {initAuthenticated} from './services/init-auth.js';
import './services/pristine-fetch.js';
import {initTheme} from './services/theme.service.js';
import {appState, resetToLogin} from './state/app.svelte.js';
import {initialize} from './startup.js';
import {defaultHostServices} from './host-services.js';

const services = defaultHostServices();

// A broken plugin must never take down the host. These window-level guards swallow
// errors originating from plugin bundle URLs; the per-widget error boundary
// is the first net, these are the second.
function isPluginSource(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value.includes('/plugins/') || value.includes('/user-plugins/');
}

function registerPluginErrorGuards(): void {
  window.addEventListener('error', (event) => {
    const message = typeof event.message === 'string' ? event.message : '';
    const filename = typeof event.filename === 'string' ? event.filename : '';
    const stack = event.error instanceof Error ? event.error.stack : '';

    if (isPluginSource(filename) || isPluginSource(stack) || isPluginSource(message)) {
      console.error('[mndw] Plugin runtime error:', event.error || event.message);
      event.preventDefault();
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const stack = reason instanceof Error ? reason.stack : String(reason);

    if (isPluginSource(stack)) {
      console.error('[mndw] Plugin unhandled rejection:', reason);
      event.preventDefault();
    }
  });
}

function mountApp(): void {
  const target = document.getElementById('app');

  if (target === null) {
    throw new Error('Missing #app mount target');
  }

  mount(App, {target, props: {services}});
}

async function checkAuthenticated(): Promise<boolean> {
  const isAuthenticated$ = services.rci.isAuthenticated().pipe(timeout(5000));

  return firstValueFrom(isAuthenticated$);
}

function subscribeAuthErrors(callback: () => void): void {
  services.rci.authError$.subscribe(callback);
}

async function init(): Promise<void> {
  registerPluginErrorGuards();

  await initialize({
    initLocale: () => services.locale.initLocale(),
    defineUi: (locale) => defineMndwUi({overlay: services.overlay, initialLocale: locale}),
    initTheme,
    initPalette: () => services.palette.initPalette(),
    checkAuthenticated,
    setAuthenticated: (authenticated) => {
      appState.authenticated = authenticated;
    },
    initAuthenticated: () => initAuthenticated(services),
    subscribeAuthErrors,
    resetToLogin,
    mountApp,
  });
}

void init();
