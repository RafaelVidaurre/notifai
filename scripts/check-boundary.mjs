#!/usr/bin/env node
/**
 * Structural boundary check for the public NotifAI CLI repository.
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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

const TOP_LEVEL_ALLOWLIST = new Set([
  '.git',
  '.gitignore',
  'README.md',
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

/** Import/require patterns that would couple public code to private code. */
const FORBIDDEN_SOURCE_PATTERNS = [
  { pattern: /@notifai\/server/, reason: 'imports the private server package' },
  { pattern: /@notifai\/contracts/, reason: 'imports the private contracts package (use @notifai/protocol)' },
  { pattern: /@notifai\/dashboard/, reason: 'imports the private dashboard package' },
  { pattern: /server-internal/, reason: 'references a private server-internal module' },
  { pattern: /testcontainers/i, reason: 'depends on the private integration-test stack' },
  { pattern: /from\s+['"](?:\.\.\/)*\.\.\/\.\.\/(?:apps|packages|ios|infra)\//, reason: 'relative import escapes the repository' },
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.json', '.yaml', '.yml'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])

const failures = []

for (const entry of readdirSync(root)) {
  if (!TOP_LEVEL_ALLOWLIST.has(entry)) {
    failures.push(`top-level entry not in allowlist: ${entry}`)
  }
}
for (const [dir, allowlist] of [
  ['apps', APPS_ALLOWLIST],
  ['packages', PACKAGES_ALLOWLIST],
]) {
  for (const entry of readdirSync(path.join(root, dir))) {
    if (!allowlist.has(entry)) failures.push(`${dir}/ entry not in allowlist: ${dir}/${entry}`)
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const relative = path.relative(root, full)
    if (SKIP_DIRS.has(entry)) continue
    const stats = statSync(full)
    for (const pattern of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(entry)) failures.push(`forbidden file: ${relative}`)
    }
    if (stats.isDirectory()) {
      walk(full)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry)) || entry === 'package.json') {
      const isSelf = relative === path.join('scripts', 'check-boundary.mjs')
      if (isSelf) continue
      const content = readFileSync(full, 'utf8')
      for (const { pattern, reason } of FORBIDDEN_SOURCE_PATTERNS) {
        if (pattern.test(content)) failures.push(`${relative}: ${reason}`)
      }
    }
  }
}
walk(root)

if (failures.length > 0) {
  console.error('Boundary check FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('Boundary check passed.')
