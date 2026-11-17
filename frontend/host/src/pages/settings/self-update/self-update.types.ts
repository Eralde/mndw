import type {SelfUpdateClient} from '../../../services/self-update-client';

export type SelfUpdateProgressPhase = 'preparing' | 'running' | 'unconfirmed';

export interface SelfUpdateProgress {
  operation: 'update' | 'revert';
  phase: SelfUpdateProgressPhase;
  targetVersion: string;
}

export type Outcome =
  | 'idle'
  | 'checking'
  | 'preparing'
  | 'error'
  | 'failure'
  | 'unconfirmed';

export type SelfUpdateOperation = 'update' | 'revert';
export type SelfUpdateAction = () => ReturnType<SelfUpdateClient['apply']>;
