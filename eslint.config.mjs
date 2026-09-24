import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'www/**', '.wrangler/**', 'android/build/**',
    'native/runtime/**', 'native/capture-helper/build/**', 'third_party/**',
    'releases/**', '**/dist/**', 'dist-worker/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: Object.fromEntries(['console', 'process', 'URL', 'Response', 'Request', 'crypto',
        'fetch', 'AbortSignal', 'WebSocket', 'WebSocketPair', 'WebSocketRequestResponsePair',
        'RTCPeerConnection', 'MediaStream', 'document', 'window', 'navigator', 'localStorage',
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'innerWidth',
        'isSecureContext', 'require', 'module', '__dirname'].map(name => [name, 'readonly']))
    }
  }
];
