// Temporary audit harness: apply a mutation, run a spec file, report which tests fail.
// Not part of the repo; deleted at the end of the audit.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MUTATIONS = JSON.parse(readFileSync(process.argv[2], 'utf8'))

function run(spec) {
  const out = `${process.env.TEMP}\\wb-mut-out.json`
  try { rmSync(out, { force: true }) } catch {}
  try {
    execFileSync('npx', ['vitest', 'run', spec, '--reporter=json', `--outputFile=${out}`], {
      stdio: 'ignore', shell: true, cwd: process.cwd(),
    })
  } catch { /* non-zero exit = failures; json still written */ }
  try {
    const j = JSON.parse(readFileSync(out, 'utf8'))
    const failed = []
    for (const suite of j.testResults ?? []) {
      for (const a of suite.assertionResults ?? []) {
        if (a.status === 'failed') failed.push(a.fullName)
      }
    }
    return { failed, total: j.numTotalTests, passed: j.numPassedTests }
  } catch (e) {
    return { failed: ['<HARNESS ERROR: no json>'], total: 0, passed: 0 }
  }
}

const results = []
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  if (!original.includes(m.find)) {
    results.push({ name: m.name, spec: m.spec, status: 'PATTERN-NOT-FOUND', failed: [] })
    continue
  }
  const mutated = original.replace(m.find, m.replace)
  if (mutated === original) {
    results.push({ name: m.name, spec: m.spec, status: 'NO-OP-REPLACE', failed: [] })
    continue
  }
  writeFileSync(m.file, mutated)
  let r
  try { r = run(m.spec) } finally { writeFileSync(m.file, original) }
  results.push({
    name: m.name, spec: m.spec,
    status: r.failed.length === 0 ? 'SURVIVED (mutation NOT caught)' : 'KILLED',
    failedCount: r.failed.length, total: r.total,
    failed: r.failed,
  })
  console.error(`[done] ${m.name} -> ${results.at(-1).status}`)
}

writeFileSync(process.argv[3], JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
