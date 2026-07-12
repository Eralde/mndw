import {createRouter} from 'sv-router';
import AppShell from '../layout/AppShell.svelte';
import DashboardPage from '../pages/dashboard/DashboardPage.svelte';
import SettingsPage from '../pages/settings/SettingsPage.svelte';

export let appRouter: ReturnType<typeof createRouter>;

/**
 * Build the authenticated app router. Phase 3 ships the static shell routes (`/`,
 * `/settings`); plugin page routes are injected here once the plugin runtime lands
 * (Phase 4).
 */
export function createAppRouter() {
  const router = createRouter({
    '/': {
      'layout': AppShell,
      '/': DashboardPage,
      '/settings': SettingsPage,
      '*': DashboardPage,
    },
  });

  appRouter = router;

  return router;
}
