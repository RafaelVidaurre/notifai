#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const failures = []

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
}

function requireValue(ok, message) {
  if (!ok) failures.push(message)
}

const rootManifest = readJson('package.json')
const packages = [
  {
    directory: 'apps/cli',
    manifest: readJson('apps/cli/package.json'),
    requiredFiles: ['LICENSE', 'README.md', 'package.json', 'tsconfig.json'],
  },
  {
    directory: 'packages/protocol',
    manifest: readJson('packages/protocol/package.json'),
    requiredFiles: ['LICENSE', 'README.md', 'package.json', 'tsconfig.json'],
  },
]

requireValue(rootManifest.private === true, 'root workspace must remain private')
requireValue(rootManifest.version === undefined, 'root workspace must not advertise a package version')
requireValue(rootManifest.engines?.node === '>=20', 'root Node support must be exactly >=20')

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
for (const entry of packages) {
  const { manifest, directory } = entry
  requireValue(semver.test(manifest.version), `${manifest.name}: version must be semver`)
  requireValue(manifest.license === 'Apache-2.0', `${manifest.name}: license must be Apache-2.0`)
  requireValue(manifest.engines?.node === '>=20', `${manifest.name}: Node support must be exactly >=20`)
  requireValue(manifest.publishConfig?.access === 'public', `${manifest.name}: publishConfig.access must be public`)
  requireValue(manifest.repository?.directory === directory, `${manifest.name}: repository.directory must be ${directory}`)
  requireValue(manifest.homepage === 'https://github.com/RafaelVidaurre/notifai#readme', `${manifest.name}: homepage is missing or unexpected`)
  requireValue(manifest.bugs?.url === 'https://github.com/RafaelVidaurre/notifai/issues', `${manifest.name}: bugs URL is missing or unexpected`)
  requireValue(
    JSON.stringify(manifest.files) === JSON.stringify(['dist', 'src', 'tsconfig.json']),
    `${manifest.name}: files allowlist must be dist, src, tsconfig.json`,
  )

  let packed
  try {
    packed = JSON.parse(
      execFileSync(
        'pnpm',
        ['--filter', manifest.name, 'pack', '--dry-run', '--json'],
        { cwd: root, encoding: 'utf8' },
      ),
    )
  } catch (error) {
    failures.push(`${manifest.name}: could not inspect pnpm pack output (${String(error)})`)
    continue
  }

  const paths = packed.files.map((file) => file.path)
  for (const required of entry.requiredFiles) {
    requireValue(paths.includes(required), `${manifest.name}: packed artifact is missing ${required}`)
  }
  for (const file of paths) {
    const allowed =
      entry.requiredFiles.includes(file) || file.startsWith('dist/') || file.startsWith('src/')
    requireValue(allowed, `${manifest.name}: unexpected packed file ${file}`)
  }
}

const cli = packages[0].manifest
const cliSource = readFileSync(path.join(root, 'apps/cli/src/main.ts'), 'utf8')
requireValue(!/\.version\(\s*['"]\d/.test(cliSource), 'CLI version must not be hardcoded in src/main.ts')
try {
  const reported = execFileSync('node', ['apps/cli/dist/main.js', '--version'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  requireValue(reported === cli.version, `CLI reports ${reported || '<empty>'}, manifest says ${cli.version}`)
} catch (error) {
  failures.push(`could not execute built CLI version check (${String(error)})`)
}

const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
for (const { manifest } of packages) {
  requireValue(
    readme.includes(`\`${manifest.name}\` ${manifest.version}`),
    `README must name the current ${manifest.name} version (${manifest.version})`,
  )
}
for (const relative of ['LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/BOUNDARY.md']) {
  requireValue(readFileSync(path.join(root, relative), 'utf8').trim().length > 0, `${relative} must not be empty`)
}
requireValue(readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License'), 'LICENSE must contain Apache-2.0')

try {
  const licenses = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8' }),
  )
  const allowedLicenses = new Set(['MIT', 'BSD-3-Clause'])
  for (const license of Object.keys(licenses)) {
    requireValue(allowedLicenses.has(license), `production dependency license requires review: ${license}`)
  }
} catch (error) {
  failures.push(`could not inspect production dependency licenses (${String(error)})`)
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  requireValue(process.env.GITHUB_REF_NAME === `v${cli.version}`, `tag must be v${cli.version}`)
}

if (failures.length > 0) {
  console.error('Release check FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `Release check passed (${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(', ')}).`,
)
