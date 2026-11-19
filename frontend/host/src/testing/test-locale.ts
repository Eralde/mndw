import {appState} from '../state/app.svelte.js';
import {type HostServices, createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';

export function createTestLocaleController(
  services: HostServices = createHostServices({
    setUiLocale: (locale): void => {
      appState.locale = locale;
    },
  }),
): {
  services: HostServices;
  context: Map<unknown, unknown>;
  setLocale: (locale: string) => Promise<void>;
} {
  const context = createHostServicesContext(services);

  return {
    services,
    context,
    setLocale: async (locale): Promise<void> => {
      await services.locale.setLocale(locale);
      appState.locale = locale;
    },
  };
}
