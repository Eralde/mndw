import type {ServiceEntry} from '../../services/service-client.js';

export interface ServiceRow {
  service: ServiceEntry;
  /** Global busy flag folded into every row so cells can disable controls. */
  busy: boolean;
  /** Whether the most recent probe/action for this row failed. */
  rowError: boolean;
}
