<script lang="ts">
import {initAuthenticated} from '../../services/init-auth.js';
import {rciService} from '../../services/rci.service.js';
import {appState, resetToLogin} from '../../state/app.svelte.js';
import {hostT} from '../../services/host-i18n.svelte.js';

let username = $state('');
let password = $state('');
let error = $state('');
let loading = $state(false);
let loginBlocked = $state(false);

function hasCredentials(): boolean {
  return username.trim() !== '' && password !== '';
}

function canSubmit(): boolean {
  return hasCredentials() && !loading && !loginBlocked;
}

// `<mndw-input>` reports through `mndwinput` rather than a bindable `value`, so the two-way flow
// is explicit: the property writes down, the event reads back up.
function onUsernameInput(e: CustomEvent<{value: string}>): void {
  username = e.detail.value;
  loginBlocked = false;
}

function onPasswordInput(e: CustomEvent<{value: string}>): void {
  password = e.detail.value;
  loginBlocked = false;
}

function handleKeydown(e: KeyboardEvent): void {
  const target = e.target;
  const source = e.composedPath()[0];

  if (
    e.key !== 'Enter'
    || !(target instanceof HTMLElement)
    || target.localName !== 'mndw-input'
    || source instanceof HTMLButtonElement
  ) {
    return;
  }

  e.preventDefault();

  if (canSubmit()) {
    handleSubmit(e);
  }
}

function handleSubmit(e: Event): void {
  e.preventDefault();

  if (!canSubmit()) {
    return;
  }

  loading = true;
  error = '';

  rciService.login(username, password).subscribe({
    next(success) {
      if (success) {
        appState.authenticated = true;
        void initAuthenticated({username, password}).catch(() => {
          resetToLogin();
          error = hostT('login.extender-setup-failed');
          loading = false;
        }).finally(() => {
          username = '';
          password = '';
        });
      } else {
        error = hostT('login.invalid-credentials');
        loading = false;
        loginBlocked = true;
      }
    },
    error() {
      error = hostT('login.connection-failed');
      loading = false;
      loginBlocked = true;
    },
  });
}
</script>

<div
  class="mndw-login"
  data-locale={appState.locale}
>
  <form
    class="mndw-login__form"
    onsubmit={handleSubmit}
  >
    <h1 class="mndw-login__title">mndw</h1>
    <mndw-field label={hostT('login.username')}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <mndw-input
        name="username"
        autocomplete="username"
        value={username}
        disabled={loading}
        onmndwinput={onUsernameInput}
        onkeydown={handleKeydown}
      ></mndw-input>
    </mndw-field>
    <mndw-field label={hostT('login.password')}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <mndw-input
        type="password"
        name="password"
        autocomplete="current-password"
        value={password}
        disabled={loading}
        onmndwinput={onPasswordInput}
        onkeydown={handleKeydown}
      ></mndw-input>
    </mndw-field>
    {#if error}
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        {error}
      </div>
    {/if}
    <mndw-button
      class="mndw-login__submit"
      variant="primary"
      type="submit"
      disabled={!canSubmit()}
    >
      {loading ? hostT('login.logging-in') : hostT('login.submit')}
    </mndw-button>
  </form>
</div>
