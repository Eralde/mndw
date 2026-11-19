export interface PluginStylesheetLease {
  loaded: Promise<void>;
  release(): void;
}

interface PluginStylesheet {
  version: string;
  link: HTMLLinkElement;
  loaded: Promise<void>;
  resolveLoaded: () => void;
  leases: number;
}

/** Owns stylesheet links for each loaded plugin version. */
export class PluginStylesheets {
  private readonly stylesheets = new Map<string, Map<string, PluginStylesheet>>();

  public acquire(name: string, version: string, href: string): PluginStylesheetLease {
    let versions = this.stylesheets.get(name);

    if (versions === undefined) {
      versions = new Map();
      this.stylesheets.set(name, versions);
    }

    const existing = versions.get(version);

    if (existing !== undefined) {
      existing.leases += 1;

      return this.createLease(name, versions, existing);
    }

    const link = document.createElement('link');
    let resolveLoaded: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    const stylesheet: PluginStylesheet = {version, link, loaded, resolveLoaded, leases: 1};

    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.pluginStyle = name;
    link.onload = () => stylesheet.resolveLoaded();
    link.onerror = () => {
      console.warn(`[mndw] No stylesheet for plugin "${name}" at ${href}`);
      stylesheet.resolveLoaded();
    };

    versions.set(version, stylesheet);
    document.head.appendChild(link);

    return this.createLease(name, versions, stylesheet);
  }

  /** Retains an existing stylesheet, or returns a no-op lease when no CSS was loaded. */
  public retain(name: string, version: string): PluginStylesheetLease {
    const versions = this.stylesheets.get(name);
    const stylesheet = versions?.get(version);

    if (versions === undefined || stylesheet === undefined) {
      return {loaded: Promise.resolve(), release: () => {}};
    }

    stylesheet.leases += 1;

    return this.createLease(name, versions, stylesheet);
  }

  private createLease(
    name: string,
    versions: Map<string, PluginStylesheet>,
    stylesheet: PluginStylesheet,
  ): PluginStylesheetLease {
    let released = false;

    return {
      loaded: stylesheet.loaded,
      release: () => {
        if (released) {
          return;
        }

        released = true;
        stylesheet.leases -= 1;

        if (stylesheet.leases !== 0 || versions.get(stylesheet.version) !== stylesheet) {
          return;
        }

        versions.delete(stylesheet.version);

        if (versions.size === 0 && this.stylesheets.get(name) === versions) {
          this.stylesheets.delete(name);
        }

        stylesheet.link.remove();
        stylesheet.resolveLoaded();
      },
    };
  }
}

export const pluginStylesheets = new PluginStylesheets();
