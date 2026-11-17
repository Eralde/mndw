<script lang="ts">
interface Action {
  label: string;
  href?: string;
  onActivate?: () => void;
  variant?: 'primary' | 'secondary';
}

interface Props {
  title: string;
  text: string;
  mode?: 'dashboard' | 'compact';
  action?: Action;
}

let {title, text, mode = 'dashboard', action}: Props = $props();
</script>

<section
  class="mndw-empty-state"
  class:mndw-empty-state--compact={mode === 'compact'}
>
  <h2 class="mndw-empty-state__title">{title}</h2>
  <p class="mndw-empty-state__text">{text}</p>
  {#if action?.href !== undefined}
    <a
      class="mndw-empty-state__link"
      href={action.href}
    >{action.label}</a>
  {:else if action?.onActivate !== undefined}
    <mndw-button
      variant={action.variant ?? 'primary'}
      onclick={action.onActivate}
    >
      {action.label}
    </mndw-button>
  {/if}
</section>
