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
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
] satisfies UserConfig[]
