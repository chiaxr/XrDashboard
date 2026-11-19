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
  ],
  build: { overwriteDest: true },
};
