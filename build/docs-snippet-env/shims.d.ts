declare module '*.svelte' {
  const component: import('svelte').Component<any>;
  export default component;
}

declare module '*.vue' {
  const component: import('vue').DefineComponent;
  export default component;
}

declare module '*.json' {
  const value: unknown;
  export default value;
}

declare module '*.css';
