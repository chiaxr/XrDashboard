// web-ext settings: package only the extension files.
export default {
  ignoreFiles: [
    'test',
    'design',
    'CLAUDE.md',
    'README.md',
    'package.json',
    'package-lock.json',
    'web-ext-config.mjs',
    // Local signing credentials: never packaged (Mozilla receives the package when signing).
    '.env',
    '.env.*',
    'web-ext-artifacts',
  ],
  build: { overwriteDest: true },
};
