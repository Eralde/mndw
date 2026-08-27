import {existsSync, renameSync, rmSync} from 'node:fs';

/**
 * Atomically replaces `destination` with `source`, keeping prior contents as a
 * recoverable backup until the move succeeds. If source promotion fails, an
 * existing destination or stale backup is restored before the error is re-thrown.
 * If final backup cleanup fails after promotion, the new destination remains
 * installed and the cleanup error is re-thrown.
 *
 * Owns only the source→destination transition and its backup/rollback. Cleanup of any
 * enclosing staging tree that contains `source` is the caller's responsibility.
 *
 * Precondition: `source` and `destination` must live on the same filesystem (true for
 * every caller — staging directories are created inside the destination's parent), so
 * both the promotion and the rollback rename are atomic.
 */
export function promoteDirectory(source: string, destination: string): void {
  const backup = `${destination}.previous`;
  const hadExisting = existsSync(destination);
  const hadBackup = existsSync(backup);

  // A stale backup conflicts with the new rollback slot only when destination exists.
  // If destination is missing, retain it as the rollback source until promotion succeeds or fails.
  if (hadExisting && hadBackup) {
    rmSync(backup, {recursive: true, force: true});
  }

  if (hadExisting) {
    renameSync(destination, backup);
  }

  try {
    renameSync(source, destination);
  } catch (error) {
    if (hadExisting || hadBackup) {
      renameSync(backup, destination);
    }

    throw error;
  }

  if (hadExisting || hadBackup) {
    rmSync(backup, {recursive: true, force: true});
  }
}
