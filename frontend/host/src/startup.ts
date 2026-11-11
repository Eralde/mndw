export interface StartupDeps {
  initLocale: () => string;
  defineUi: (locale: string) => void;
  initTheme: () => void;
  initPalette: () => Promise<void>;
  checkAuthenticated: () => Promise<boolean>;
  setAuthenticated: (authenticated: boolean) => void;
  /** Init resolves with the generation of its auth run; startup ignores the value. */
  initAuthenticated: () => Promise<unknown>;
  getAuthRunGeneration: () => number;
  subscribeAuthErrors: (callback: () => void) => void;
  resetToLogin: () => void;
  mountApp: () => void;
}

export async function initialize(deps: StartupDeps): Promise<void> {
  const locale = deps.initLocale();

  deps.defineUi(locale);
  deps.initTheme();

  try {
    await deps.initPalette();
  } catch (error) {
    console.warn('[mndw] Palette startup load failed; continuing to login.', error);
  }

  let authenticated = false;

  try {
    authenticated = await deps.checkAuthenticated();
  } catch {
    authenticated = false;
  }

  deps.setAuthenticated(authenticated);

  let authErrorReceived = false;

  deps.subscribeAuthErrors(() => {
    authErrorReceived = true;
    deps.resetToLogin();
  });

  deps.mountApp();

  if (authenticated && !authErrorReceived) {
    let generation: number | undefined;

    try {
      const initialization = deps.initAuthenticated();
      generation = deps.getAuthRunGeneration();
      await initialization;
    } catch {
      if (generation === undefined || generation === deps.getAuthRunGeneration()) {
        deps.resetToLogin();
      }
    }
  }
}
