const pluginVersionWarnings = $state<Record<string, string[]>>({});

export function clearPluginVersionWarnings(): void {
  for (const name of Object.keys(pluginVersionWarnings)) {
    delete pluginVersionWarnings[name];
  }
}

export function setPluginVersionWarnings(name: string, mismatches: string[]): void {
  if (mismatches.length === 0) {
    delete pluginVersionWarnings[name];

    return;
  }

  pluginVersionWarnings[name] = [...mismatches];
}

export function getPluginVersionWarnings(name: string): string[] {
  return pluginVersionWarnings[name] ?? [];
}
