<script lang="ts">
import {initAuthenticated} from '../../services/init-auth.js';
import {rciService} from '../../services/rci.service.js';
import {appState} from '../../state/app.svelte.js';

let username = $state('');
let password = $state('');
let error = $state('');
let loading = $state(false);

// `<mndw-input>` reports through `mndwinput` rather than a bindable `value`, so the two-way flow
// is explicit: the property writes down, the event reads back up.
function onUsernameInput(e: CustomEvent<{value: string}>): void {
  username = e.detail.value;
}

function onPasswordInput(e: CustomEvent<{value: string}>): void {
  password = e.detail.value;
}

function handleSubmit(e: Event): void {
  e.preventDefault();
  loading = true;
  error = '';

  rciService.login(username, password).subscribe({
    next(success) {
      if (success) {
        appState.authenticated = true;
        void initAuthenticated();
      } else {
        error = 'Invalid credentials';
        loading = false;
      }
    },
    error() {
      error = 'Connection failed';
      loading = false;
    },
  });
}
</script>

<div class="mndw-login">
  <form
    class="mndw-login__form"
    onsubmit={handleSubmit}
  >
    <h1 class="mndw-login__title">mndw</h1>
    <mndw-field label="Username">
      <mndw-input
        name="username"
        autocomplete="username"
        value={username}
        disabled={loading}
        onmndwinput={onUsernameInput}
      ></mndw-input>
    </mndw-field>
    <mndw-field label="Password">
      <mndw-input
        type="password"
        name="password"
        autocomplete="current-password"
        value={password}
        disabled={loading}
        onmndwinput={onPasswordInput}
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
    <button
      type="submit"
      disabled={loading}
    >
      {loading ? 'Logging in...' : 'Login'}
    </button>
  </form>
</div>
