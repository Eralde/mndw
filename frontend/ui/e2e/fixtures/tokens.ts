import '@mndw/sdk/tokens.css';

const override = document.createElement('style');

override.textContent = `
  :root {
    --mndw-surface: rgb(17 34 51);
    --mndw-accent: rgb(68 85 102);
    --mndw-shadow-color: rgb(10 20 30 / 50%);
  }
`;
document.head.appendChild(override);

const probe = document.querySelector<HTMLElement>('[data-testid="probe"]');

if (!probe) {
  throw new Error('token probe missing');
}

probe.style.boxShadow = 'var(--mndw-shadow-2)';
probe.style.backgroundColor = 'var(--mndw-scrollbar-thumb)';
document.documentElement.dataset.ready = 'true';
