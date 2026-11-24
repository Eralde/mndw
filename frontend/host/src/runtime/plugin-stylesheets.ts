export interface PluginStylesheetLease {
  loaded: Promise<void>;
  release(): void;
}

interface PluginStylesheet {
  revision: string;
  link: HTMLLinkElement;
  loaded: Promise<void>;
  resolveLoaded: () => void;
  leases: number;
}

export interface PluginAssetIdentity {
  version: string;
  installedAt?: string;
}

// URL callers encode this revision with encodeURIComponent so timestamps stay in one query value.
export function assetRevision(entry: PluginAssetIdentity): string {
  if (entry.installedAt === undefined) {
    return entry.version;
  }

  return `${entry.version}@${entry.installedAt}`;
}

/** Owns stylesheet links for each loaded plugin asset revision. */
export class PluginStylesheets {
  private readonly stylesheets = new Map<string, Map<string, PluginStylesheet>>();

  public acquire(name: string, revision: string, href: string): PluginStylesheetLease {
    let versions = this.stylesheets.get(name);

    if (versions === undefined) {
      versions = new Map();
      this.stylesheets.set(name, versions);
    }

    const existing = versions.get(revision);

    if (existing !== undefined) {
      existing.leases += 1;

      return this.createLease(name, versions, existing);
    }

    const link = document.createElement('link');
    let resolveLoaded: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    const stylesheet: PluginStylesheet = {revision, link, loaded, resolveLoaded, leases: 1};

    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.pluginStyle = name;
    link.onload = () => stylesheet.resolveLoaded();
    link.onerror = () => {
      console.warn(`[mndw] No stylesheet for plugin "${name}" at ${href}`);
      stylesheet.resolveLoaded();
    };

    versions.set(revision, stylesheet);
    document.head.appendChild(link);

    return this.createLease(name, versions, stylesheet);
  }

  /** Retains an existing stylesheet, or returns a no-op lease when no CSS was loaded. */
  public retain(name: string, revision: string): PluginStylesheetLease {
    const versions = this.stylesheets.get(name);
    const stylesheet = versions?.get(revision);

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

        if (stylesheet.leases !== 0 || versions.get(stylesheet.revision) !== stylesheet) {
          return;
        }

        versions.delete(stylesheet.revision);

        if (versions.size === 0 && this.stylesheets.get(name) === versions) {
          this.stylesheets.delete(name);
        }

        stylesheet.link.remove();
        stylesheet.resolveLoaded();
      },
    };
  }
}
