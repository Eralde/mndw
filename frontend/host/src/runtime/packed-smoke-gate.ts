export type PackedSmokeDecision = 'run' | 'skip' | 'fail';

export function decidePackedSmoke(packedReady: boolean, skipValue: string | undefined): PackedSmokeDecision {
  if (packedReady) {
    return 'run';
  }

  return skipValue === '1' ? 'skip' : 'fail';
}
