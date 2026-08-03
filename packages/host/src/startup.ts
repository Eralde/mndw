export interface StartupDeps {
  defineUi: () => void;
  initTheme: () => void;
  initPalette: () => Promise<void>;
  checkAuthenticated: () => Promise<boolean>;
  setAuthenticated: (authenticated: boolean) => void;
  initAuthenticated: () => Promise<void>;
  subscribeAuthErrors: (callback: () => void) => void;
  resetToLogin: () => void;
  mountApp: () => void;
}

export async function initialize(deps: StartupDeps): Promise<void> {
  deps.defineUi();
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

  if (authenticated) {
    try {
      await deps.initAuthenticated();
    } catch {
      deps.resetToLogin();
    }
  }

  deps.subscribeAuthErrors(() => {
    deps.resetToLogin();
  });

  deps.mountApp();
}
