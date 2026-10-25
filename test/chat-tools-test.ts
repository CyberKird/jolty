import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeBlocks, diffText, newContent, quotePath, resolvePath, shellCommand, tableText, valueKind } from '../src/shared/copy-values'
import { COPY_RULE } from '../src/main/engines/prompt'

test('copy chips: values yes, ordinary words no', () => {
  const yes: Record<string, string> = {
    'https://example.com/a?b=1': 'url',
    'E:\\Proiecte\\Aplicatii\\jolty': 'path',
    'src/main/index.ts': 'path',
    'package.json': 'path',
    'Chat.tsx:120': 'path',
    './scripts/run.sh': 'path',
    'npm run build': 'command',
    '$ git status': 'command',
    'v1.2.3': 'version',
    '820cac3': 'hash',
    'localhost:3000': 'port',
    ':5173': 'port',
    NODE_ENV: 'env',
    'FOO=bar': 'env',
    '--no-verify': 'flag',
    '"compilerOptions"': 'key'
  }
  for (const [text, kind] of Object.entries(yes)) assert.equal(valueKind(text), kind, text)
  for (const word of ['config', 'React.memo', 'and/or', 'true', '42', '2024/10/25', 'useState', 'deadbeef', 'GET', 'e.g.', 'a b c', '']) assert.equal(valueKind(word), undefined, word)
})

test('shell blocks copy only the commands', () => {
  assert.equal(shellCommand('npm install\nnpm test'), 'npm install\nnpm test')
  assert.equal(shellCommand('$ npm install\nadded 12 packages\n$ npm test'), 'npm install\nnpm test')
  assert.equal(shellCommand('$ docker run \\\n  -p 80:80 img\nok'), 'docker run \\\n  -p 80:80 img')
  assert.equal(shellCommand('PS C:\\work> dir\nMode Name'), 'dir')
})

test('code blocks of a reply, last one included while it streams', () => {
  const md = 'a\n```ts\nconst a = 1\n```\ntext\n~~~\nplain\n~~~\n```bash\nnpm i'
  assert.deepEqual(codeBlocks(md).map((b) => b.code), ['const a = 1', 'plain', 'npm i'])
  assert.equal(codeBlocks(md)[0].lang, 'ts')
  assert.equal(codeBlocks('no code here').length, 0)
})

test('tables as Markdown, TSV and CSV', () => {
  const rows = [['Name', 'Note'], ['a|b', 'say "hi", ok']]
  assert.equal(tableText(rows, 'tsv'), 'Name\tNote\na|b\tsay "hi", ok')
  assert.equal(tableText(rows, 'csv'), 'Name,Note\na|b,"say ""hi"", ok"')
  assert.equal(tableText(rows, 'md'), '| Name | Note |\n| --- | --- |\n| a\\|b | say "hi", ok |')
})

test('diff and new file content', () => {
  const diffs = [{ path: 'a.ts', kind: 'update' as const, diff: '-x\n+y' }]
  assert.equal(diffText(diffs), 'a.ts\n-x\n+y')
  assert.equal(newContent({ content: 'whole' }, diffs), 'whole')
  assert.equal(newContent({ edits: [{ new_string: 'p' }, { new_string: 'q' }] }), 'p\nq')
  assert.equal(newContent({}, [{ path: 'n', kind: 'add', diff: '+one\n+two' }]), 'one\ntwo')
})

test('paths: relative ones join the working folder, Copy as path quotes', () => {
  assert.equal(resolvePath('src/a.ts:12', 'E:\\proj'), 'E:\\proj\\src\\a.ts')
  assert.equal(resolvePath('C:/x/y'), 'C:\\x\\y')
  assert.equal(resolvePath('src/a.ts'), undefined)
  assert.equal(quotePath('C:\\x y\\z'), '"C:\\x y\\z"')
})

test('the copy-field rule stays short and has no dashes', () => {
  assert.ok(COPY_RULE.length < 330, `${COPY_RULE.length} chars`)
  assert.ok(!/[\u2013\u2014]/.test(COPY_RULE))
})
