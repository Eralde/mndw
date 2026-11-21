/** Options for a toast shown by a plugin context. */
export interface PluginToastOptions {
  readonly message: string;
  readonly variant?: 'success' | 'info' | 'warning' | 'error';
  /** Replaces an existing toast with this key in the same plugin instance. */
  readonly key?: string;
  /** Milliseconds before auto-dismiss. Zero keeps the toast until dismissed. */
  readonly duration?: number;
  readonly action?: {
    readonly label: string;
    readonly onAction: () => void | Promise<void>;
  };
}

/** Handle for dismissing one toast. */
export interface PluginToastHandle {
  dismiss(): void;
}

export type PluginToastShortcutOptions = Omit<PluginToastOptions, 'message' | 'variant'>;

/** Toast notifications scoped to one mounted plugin instance. */
export interface PluginToasts {
  show(options: PluginToastOptions): PluginToastHandle;
  success(message: string, options?: PluginToastShortcutOptions): PluginToastHandle;
  info(message: string, options?: PluginToastShortcutOptions): PluginToastHandle;
  warning(message: string, options?: PluginToastShortcutOptions): PluginToastHandle;
  error(message: string, options?: PluginToastShortcutOptions): PluginToastHandle;
  /** Dismiss the toast with this key in the current plugin instance. */
  dismiss(key: string): void;
}
