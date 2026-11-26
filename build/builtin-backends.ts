// These backends are compiled into mndwd and run as `mndwd backend <name>`.
// Device packages ship a wrapper script for each backend.
// Keep this list equal to `builtinBackendEntries` in `daemon/mndwd/cmd/mndwd/backend_dispatch.go`;
// `plugin-backends.test.ts` checks that list.
export const BUILTIN_BACKEND_NAMES = ['terminal-backend', 'mwsd', 'dns-util'] as const;
