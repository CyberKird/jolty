// A stand-in for the GitHub CLI in tests: JOLTY_GH points here, GH_STUB_DIR holds the one bit of state (auto-merge).
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const marker = path.join(process.env.GH_STUB_DIR || '.', 'auto-merge')
const say = (v) => process.stdout.write(JSON.stringify(v))
const [area, verb] = args

if (process.env.GH_STUB_MODE === 'norepo') {
  process.stderr.write('none of the git remotes configured for this repository point to a known GitHub host')
  process.exit(1)
}
if (process.env.GH_STUB_MODE === 'noauth') {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login')
  process.exit(4)
}

if (area === 'repo' && verb === 'view') say({ nameWithOwner: 'acme/shop' })
else if (area === 'pr' && verb === 'view') {
  if (process.env.GH_STUB_MODE === 'nopr') {
    process.stderr.write('no pull requests found for branch "main"')
    process.exit(1)
  }
  say({
    number: 12,
    title: 'Add checkout',
    url: 'https://github.com/acme/shop/pull/12',
    state: 'OPEN',
    isDraft: false,
    autoMergeRequest: fs.existsSync(marker) ? { mergeMethod: 'SQUASH' } : null,
    statusCheckRollup: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { context: 'ci/legacy', state: 'FAILURE' }
    ]
  })
} else if (area === 'pr' && verb === 'merge') {
  if (args.includes('--auto')) fs.writeFileSync(marker, 'on')
  else if (args.includes('--disable-auto')) fs.rmSync(marker, { force: true })
} else if (area === 'issue' && verb === 'list') {
  say([
    { number: 7, title: 'Cart loses items', labels: [{ name: 'bug' }], author: { login: 'ana' } },
    { number: 9, title: 'Dark mode', labels: [], author: { login: 'dan' } }
  ])
} else if (area === 'issue' && verb === 'view') {
  say({ number: Number(args[2]), title: 'Cart loses items', url: 'https://github.com/acme/shop/issues/7', labels: [{ name: 'bug' }], body: 'Items vanish after login.', comments: [{ author: { login: 'dan' }, body: 'Same here.' }] })
} else {
  process.stderr.write('unknown command: ' + args.join(' '))
  process.exit(2)
}
