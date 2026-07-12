<script lang="ts">
import {initAuthenticated} from '../../services/init-auth.js';
import {rciService} from '../../services/rci.service.js';
import {appState} from '../../state/app.svelte.js';

let username = $state('');
let password = $state('');
let error = $state('');
let loading = $state(false);

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
    <input
      type="text"
      placeholder="Username"
      bind:value={username}
      disabled={loading}
    />
    <input
      type="password"
      placeholder="Password"
      bind:value={password}
      disabled={loading}
    />
    {#if error}
      <div class="mndw-login__error">{error}</div>
    {/if}
    <button
      type="submit"
      disabled={loading}
    >
      {loading ? 'Logging in...' : 'Login'}
    </button>
  </form>
</div>
