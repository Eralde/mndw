<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {DeviceTypeOverride} from '../../model/api';
import type {WakeDecision} from '../../services/confirm-wake';
import type {ActionResult, PageState} from '../../services/page-controller';
import DeviceDetails from '../DeviceDetails.svelte';

interface Props {
  initialState: PageState;
  i18n: Translator;
  onDiscover: (targetDeviceId: string | undefined) => Promise<ActionResult>;
  onRefresh: (targetDeviceId: string | undefined) => Promise<ActionResult>;
  onSetDeviceType: (
    deviceId: string,
    deviceType: DeviceTypeOverride | null,
  ) => Promise<ActionResult>;
  confirmWake: (
    canRemember: boolean,
    signal: AbortSignal,
  ) => Promise<WakeDecision>;
  onFocusLost?: () => void;
}

let {initialState, i18n, onDiscover, onRefresh, onSetDeviceType, confirmWake,
  onFocusLost}: Props = $props();
// svelte-ignore state_referenced_locally
let state = $state(initialState);

/** Lets a test replace the page state while the component stays mounted. */
export function update(next: PageState): void {
  state = next;
}

function selectDevice(deviceId: string | null): void {
  state = {...state, selectedDeviceId: deviceId};
}
</script>

<nav aria-label="Test device selection">
  <button
    data-testid="select-dev-a"
    onclick={() => selectDevice('dev-a')}
  >
    A
  </button>
  <button
    data-testid="select-none"
    onclick={() => selectDevice(null)}
  >
    None
  </button>
  <button
    data-testid="select-dev-b"
    onclick={() => selectDevice('dev-b')}
  >
    B
  </button>
</nav>
<DeviceDetails
  {state}
  {i18n}
  {onDiscover}
  {onRefresh}
  {onSetDeviceType}
  {confirmWake}
  {onFocusLost}
/>
