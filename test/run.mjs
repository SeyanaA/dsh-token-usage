#!/usr/bin/env node
/** Runs every plugin test; exits non-zero when any file fails. */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tests = ['host-fold.mjs', 'client-render.mjs']
let failed = 0
for (const test of tests) {
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed} test file(s) failed`)
  process.exit(1)
}
console.log('\nall token-usage tests passed')
