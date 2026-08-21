import {mount, unmount} from 'svelte';
import type {CellRenderer} from '@mndw/ui';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageDetailCell from './PackageDetailCell.svelte';
import type {PackageDetailCache} from './PackageDetailCell.svelte';

export interface PackageDetailRendererOptions {
  cache: PackageDetailCache;
  load(name: string): void;
  retry(name: string): void;
}

export function packageDetailRenderer(
  options: PackageDetailRendererOptions,
): () => CellRenderer<PackageEntry, PackageEntry> {
  return () => {
    let app: ReturnType<typeof mount> | undefined;
    let props: {
      row: PackageEntry;
      value: PackageEntry;
      colId: string;
      cache: PackageDetailCache;
      load: (name: string) => void;
      retry: (name: string) => void;
    } | undefined;

    return {
      mount(context) {
        const state = $state({
          row: context.row as PackageEntry,
          value: context.value as PackageEntry,
          colId: context.colId,
          cache: options.cache,
          load: options.load,
          retry: options.retry,
        });

        props = state;
        app = mount(PackageDetailCell, {target: context.node, props: state});
      },
      update(context) {
        if (props !== undefined) {
          props.row = context.row as PackageEntry;
          props.value = context.value as PackageEntry;
          props.colId = context.colId;
        }
      },
      destroy() {
        if (app !== undefined) {
          unmount(app);
          app = undefined;
        }

        props = undefined;
      },
    };
  };
}

export type {PackageDetailState} from './PackageDetailCell.svelte';
