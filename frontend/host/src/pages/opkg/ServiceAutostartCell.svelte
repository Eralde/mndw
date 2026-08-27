<script lang="ts">
import type {MndwSwitchChangeDetail} from '@mndw/ui';
import {hostT} from '../../services/host-i18n.svelte.js';
import type {ServiceRow} from './service-row.js';

type Props = {row: ServiceRow; onToggle: (enabled: boolean) => void};

let {row, onToggle}: Props = $props();

const disabled = $derived.by(() =>
  row.busy || row.service.protected || row.service.autostartPinned
);

const ariaLabel = $derived.by(() =>
  row.service.enabledAtBoot
    ? hostT('services.disable-at-boot')
    : hostT('services.enable-at-boot')
);

const title = $derived.by(() => {
  if (row.service.protected) {
    return hostT('services.protected');
  }
  if (row.service.autostartPinned) {
    return hostT('services.autostart-pinned');
  }
  return ariaLabel;
});

const onChange = (event: CustomEvent<MndwSwitchChangeDetail>): void => {
  const control = event.currentTarget as HTMLElement & {checked: boolean};
  control.checked = row.service.enabledAtBoot;
  onToggle(!row.service.enabledAtBoot);
};
</script>

<mndw-switch
  checked={row.service.enabledAtBoot}
  {disabled}
  aria-label={ariaLabel}
  {title}
  onmndwchange={onChange}
></mndw-switch>
