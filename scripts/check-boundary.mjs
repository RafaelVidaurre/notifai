#!/usr/bin/env node
/**
 * Structural boundary check for the public Notifai CLI repository.
 *
 * Fails when the tree contains anything that is not part of the public
 * client surface: unexpected top-level entries, extra workspace packages,
 * files whose names mark private material, or source imports that reach
 * for private packages. See docs/BOUNDARY.md for the policy this enforces.
 *
 * Identifier-level scanning (hosting app names, team identifiers, private
 * repository references) deliberately lives in the private repository's
 * scanner, so its patterns are not published here.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

const TOP_LEVEL_ALLOWLIST = new Set([
  '.git',
  '.gitignore',
  // CI only. Workflow files are scanned for forbidden content like any other
  // source, so this admits the directory without admitting what it may say —
  // and nothing here may reference private infrastructure, deployment, or
  // signing, which is exactly what a CI directory is tempting to fill with.
  '.github',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs',
  'scripts',
  'apps',
  'packages',
  'skills',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  'node_modules',
])

const APPS_ALLOWLIST = new Set(['cli'])
const PACKAGES_ALLOWLIST = new Set(['protocol'])

/** File names or extensions that mark material the public repo must not hold. */
const FORBIDDEN_FILE_PATTERNS = [
  /\.p8$/i,
  /\.p12$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.keystore$/i,
  /\.mobileprovision$/i,
  /\.provisionprofile$/i,
  /\.xcconfig$/i,
  /\.entitlements$/i,
  /^\.env(\..*)?$/i,
  /^fly\.toml$/i,
  /^Dockerfile$/i,
  /^docker-compose/i,
  /\.xcodeproj$/i,
  /\.xcworkspace$/i,
]

/**
 * Import/require patterns that would couple public code to private code.
 *
 * `control` is a string the pattern MUST still match, asserted before any
 * file is read. These patterns name private packages, so they change whenever
 * those packages are renamed — and a pattern that has quietly stopped
 * matching reports a clean tree, which is indistinguishable from a tree that
 * is actually clean. That already happened once here.
 */
const FORBIDDEN_SOURCE_PATTERNS = [
  { pattern: /@raidiant\/notifai-server/, reason: 'imports the private server package', control: "from '@raidiant/notifai-server'" },
  { pattern: /@raidiant\/notifai-contracts/, reason: 'imports the private contracts package (use @raidiant/notifai-protocol)', control: "from '@raidiant/notifai-contracts'" },
  { pattern: /@raidiant\/notifai-dashboard/, reason: 'imports the private dashboard package', control: "from '@raidiant/notifai-dashboard'" },
  { pattern: /server-internal/, reason: 'references a private server-internal module' },
  { pattern: /testcontainers/i, reason: 'depends on the private integration-test stack' },
  { pattern: /from\s+['"](?:\.\.\/)*\.\.\/\.\.\/(?:apps|packages|ios|infra)\//, reason: 'relative import escapes the repository' },
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.json', '.yaml', '.yml'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])

for (const { pattern, control } of FORBIDDEN_SOURCE_PATTERNS) {
  if (control !== undefined && !pattern.test(control)) {
    console.error(`error: ${pattern} no longer matches its control string (${control}).`)
    console.error('A pattern that cannot match its own example cannot clear a tree.')
    process.exit(2)
  }
}

function scan(scanRoot) {
  const failures = []

  for (const entry of readdirSync(scanRoot)) {
    if (!TOP_LEVEL_ALLOWLIST.has(entry)) {
      failures.push(`top-level entry not in allowlist: ${entry}`)
    }
  }
  for (const [dir, allowlist] of [
    ['apps', APPS_ALLOWLIST],
    ['packages', PACKAGES_ALLOWLIST],
  ]) {
    for (const entry of readdirSync(path.join(scanRoot, dir))) {
      if (!allowlist.has(entry)) failures.push(`${dir}/ entry not in allowlist: ${dir}/${entry}`)
    }
  }

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const relative = path.relative(scanRoot, full)
      if (SKIP_DIRS.has(entry)) continue
      const stats = statSync(full)
      for (const pattern of FORBIDDEN_FILE_PATTERNS) {
        if (pattern.test(entry)) failures.push(`forbidden file: ${relative}`)
      }
      if (stats.isDirectory()) {
        walk(full)
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry)) || entry === 'package.json') {
        const isSelf = scanRoot === root && relative === path.join('scripts', 'check-boundary.mjs')
        if (isSelf) continue
        const content = readFileSync(full, 'utf8')
        for (const { pattern, reason } of FORBIDDEN_SOURCE_PATTERNS) {
          if (pattern.test(content)) failures.push(`${relative}: ${reason}`)
        }
      }
    }
  }
  walk(scanRoot)
  return failures
}

function selfTest() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-boundary-control-'))
  try {
    mkdirSync(path.join(fixture, 'apps', 'cli'), { recursive: true })
    mkdirSync(path.join(fixture, 'packages', 'protocol'), { recursive: true })
    writeFileSync(path.join(fixture, 'package.json'), '{}\n')
    if (scan(fixture).length !== 0) throw new Error('clean control fixture did not pass')

    const topLevelCanary = path.join(fixture, 'private-service')
    writeFileSync(topLevelCanary, 'control\n')
    if (!scan(fixture).some((failure) => failure.includes('top-level entry'))) {
      throw new Error('top-level allowlist did not catch its positive control')
    }
    rmSync(topLevelCanary, { force: true })

    const fileCanary = path.join(fixture, 'apps', 'cli', '.env')
    writeFileSync(fileCanary, 'CONTROL=true\n')
    if (!scan(fixture).some((failure) => failure.includes('forbidden file'))) {
      throw new Error('forbidden-file scan did not catch its positive control')
    }
    rmSync(fileCanary, { force: true })

    const importCanary = path.join(fixture, 'apps', 'cli', 'control.ts')
    writeFileSync(importCanary, `${FORBIDDEN_SOURCE_PATTERNS[0].control}\n`)
    if (!scan(fixture).some((failure) => failure.includes('private server package'))) {
      throw new Error('private-import scan did not catch its positive control')
    }
    rmSync(importCanary, { force: true })

    mkdirSync(path.join(fixture, 'apps', 'server'))
    if (!scan(fixture).some((failure) => failure.includes('apps/server'))) {
      throw new Error('workspace allowlist did not catch its positive control')
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
  console.log('Boundary positive controls passed.')
}

if (process.argv.includes('--self-test')) {
  selfTest()
  process.exit(0)
}

const failures = scan(root)

if (failures.length > 0) {
  console.error('Boundary check FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('Boundary check passed.')
