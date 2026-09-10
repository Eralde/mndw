// Narrow declaration for Vite's combined asset query used by e2e fixtures. The host package has its
// own vite-env.d.ts; UI e2e files compile in a separate context and need this one.
declare module '*.svg?url&no-inline' {
  const url: string;
  export default url;
}
