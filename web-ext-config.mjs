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
    'scripts',
    'updates.json',
    // Local signing credentials: never packaged (Mozilla receives the package when signing).
    '.env',
    '.env.*',
    'web-ext-artifacts',
  ],
  build: { overwriteDest: true },
  // update_url is allowed for self-hosted (unlisted) add-ons.
  lint: { selfHosted: true },
};
