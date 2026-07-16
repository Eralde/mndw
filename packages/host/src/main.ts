import '@mndw/sdk/tokens.css';
import './styles/global.css';
import {firstValueFrom, timeout} from 'rxjs';
import {mount} from 'svelte';
import App from './App.svelte';
import {initAuthenticated} from './services/init-auth.js';
import {rciService} from './services/rci.service.js';
import {initTheme} from './services/theme.service.js';
import {appState, resetToLogin} from './state/app.svelte.js';

// A broken plugin must never take down the host. These window-level guards swallow
// errors originating from plugin bundle URLs; the per-widget error boundary (Phase 4)
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

async function init(): Promise<void> {
  registerPluginErrorGuards();
  initTheme();

  try {
    const isAuthenticated$ = rciService.isAuthenticated().pipe(timeout(5000));

    appState.authenticated = await firstValueFrom(isAuthenticated$);
  } catch {
    appState.authenticated = false;
  }

  if (appState.authenticated) {
    await initAuthenticated();
  }

  rciService.authError$.subscribe(() => {
    resetToLogin();
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  mount(App, {target: document.getElementById('app')!});
}

void init();
