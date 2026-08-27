import {Injectable, inject, signal} from '@angular/core';
import type {PluginStorage} from '@mndw/sdk';
import {PLUGIN_STORAGE} from '../tokens';

export const EXTRA_FEATURES_BANNER_DISMISSED_KEY = 'extra-features-banner-dismissed-v1';

@Injectable()
export class ExtraFeaturesBannerStore {
  private readonly storage = inject<PluginStorage>(PLUGIN_STORAGE);
  private dismissedLocally = false;

  public readonly loaded = signal(false);
  public readonly dismissed = signal(false);

  public async load(): Promise<void> {
    try {
      const value = await this.storage.get(EXTRA_FEATURES_BANNER_DISMISSED_KEY);

      if (!this.dismissedLocally) {
        this.dismissed.set(value === 'true');
      }
    } catch {
      if (!this.dismissedLocally) {
        this.dismissed.set(false);
      }
    } finally {
      this.loaded.set(true);
    }
  }

  public dismiss(): void {
    this.dismissedLocally = true;
    this.dismissed.set(true);
    void this.storage.set(EXTRA_FEATURES_BANNER_DISMISSED_KEY, 'true').catch(() => undefined);
  }
}
