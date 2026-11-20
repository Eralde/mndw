import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {PackageCellRow} from './package-actions-renderer.svelte.js';
import PackageDetailCell from './PackageDetailCell.svelte';
import type {PackageDetailCache} from './PackageDetailCell.svelte';

export interface PackageDetailRendererOptions {
  cache: PackageDetailCache;
  load(name: string): void;
  retry(name: string): void;
  onRemove(name: string): void;
}

interface PackageDetailExtra {
  cache: PackageDetailCache;
  load: (name: string) => void;
  retry: (name: string) => void;
  onRemove: () => void;
}

export function packageDetailRenderer(
  options: PackageDetailRendererOptions,
): () => CellRenderer<PackageCellRow, PackageCellRow> {
  return svelteCellWith<
    PackageCellRow,
    PackageCellRow,
    PackageDetailExtra,
    ComponentProps<typeof PackageDetailCell>
  >(
    PackageDetailCell,
    (state) => ({
      cache: options.cache,
      load: options.load,
      retry: options.retry,
      onRemove: () => options.onRemove(state.row.name),
    }),
  );
}
