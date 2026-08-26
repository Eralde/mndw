import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageDetailCell from './PackageDetailCell.svelte';
import type {PackageDetailCache} from './PackageDetailCell.svelte';

export interface PackageDetailRendererOptions {
  cache: PackageDetailCache;
  load(name: string): void;
  retry(name: string): void;
}

interface PackageDetailExtra {
  cache: PackageDetailCache;
  load: (name: string) => void;
  retry: (name: string) => void;
}

export function packageDetailRenderer(
  options: PackageDetailRendererOptions,
): () => CellRenderer<PackageEntry, PackageEntry> {
  return svelteCellWith<
    PackageEntry,
    PackageEntry,
    PackageDetailExtra,
    ComponentProps<typeof PackageDetailCell>
  >(
    PackageDetailCell,
    () => ({
      cache: options.cache,
      load: options.load,
      retry: options.retry,
    }),
  );
}

export type {PackageDetailState} from './PackageDetailCell.svelte';
