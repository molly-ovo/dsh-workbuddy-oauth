import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-workbuddy-standalone'

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

/** Build-time define map; `src/version.ts` reads `__DSH_WORKBUDDY_STANDALONE_VERSION__`. */
const VERSION_DEFINE = {
  __DSH_WORKBUDDY_STANDALONE_VERSION__: JSON.stringify(PACKAGE_VERSION),
}

/**
 * Modules the host loader provides to the browser bundle.
 *
 * The verified platform seed on DSH 2.0.16 is exactly:
 * `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 * `@deepseek-ai/dsh-client-ui-dockkit`.
 *
 * Only what this bundle *actually imports* is listed. `react-dom` is in the seed
 * but unused here, and adding unused externals would let the bundle require
 * something no one verified it needs; the client's DSH imports are type-only
 * today and erase at build time, so the emitted bundle requires React alone.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
] as const

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    // The host half owns `clean`, and it runs first; cleaning here would delete
    // the entry this build was configured to sit beside.
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      // The loader registers a bundle by the id its factory declares and looks
      // that id up by *package name*, so this must spell the package exactly:
      // `client-modules: could not load "<id>": ... loaded without registering
      // "<id>" via __ModuleLoader__.load` is the failure otherwise.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
