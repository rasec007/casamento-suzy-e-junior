import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', '.local-runtime/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest', sourceType: 'module',
      globals: Object.fromEntries(['AbortSignal','Blob','Buffer','Date','Error','Element','EventSource','FormData','Intl','JSON','Math','MutationObserver','Node','Promise','Set','String','Number','Object','Array','URL','URLSearchParams','WebSocket','clearInterval','clearTimeout','confirm','console','document','fetch','history','location','matchMedia','process','prompt','setInterval','setTimeout','window','IntersectionObserver'].map(name => [name, 'readonly']))
    }
  }
];
