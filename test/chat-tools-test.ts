import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeBlocks, diffText, newContent, quotePath, resolvePath, shellCommand, tableText, valueKind } from '../src/shared/copy-values'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COPY_RULE, IMAGE_RULE } from '../src/main/engines/prompt'
import { embeddable, needsClick } from '../src/shared/chat-image'
import { chatImage, localImagePath, sniff } from '../src/main/chat-images'

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
    'vercel deploy --prod': 'command',
    'my-tool run --fast x': 'command',
    'laundry-cheatsheet.vercel.app': 'url',
    'laundry-cheatsheet-nicusoraron-2411s-projects.vercel.app': 'url',
    'example.com/docs': 'url',
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
  for (const word of ['config', 'React.memo', 'and/or', 'true', '42', '2024/10/25', 'useState', 'deadbeef', 'GET', 'e.g.', 'a b c', 'obj.method', 'Array.from', 'a - b', '']) assert.equal(valueKind(word), undefined, word)
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

test('the image rule shows the Markdown form and has no dashes', () => {
  assert.ok(IMAGE_RULE.includes('![short description]('))
  assert.ok(!/[–—]/.test(IMAGE_RULE))
})

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('chat images: only real raster images, sniffed from the bytes', () => {
  assert.equal(sniff(PNG_1PX), 'png')
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(sniff(Buffer.from('GIF89a')), 'gif')
  assert.equal(sniff(Buffer.from('RIFF0000WEBPVP8 ')), 'webp')
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), undefined)
  assert.equal(sniff(Buffer.from('<html>')), undefined)
})

test('chat images: what may be embedded and what waits for a click', () => {
  assert.ok(embeddable('https://img.game8.co/utzttn7vvo7gdub8b5tr16cmt9bm'))
  assert.ok(embeddable(String.raw`E:\shots\map.png`))
  assert.ok(embeddable('/E:/shots/map.webp'))
  assert.ok(embeddable('file:///C:/x/y.jpg'))
  assert.ok(!embeddable('http://example.com/a.png'))
  assert.ok(!embeddable(String.raw`E:\tools\run.exe`))
  assert.ok(!embeddable('javascript:alert(1)'))
  assert.ok(!embeddable('data:image/svg+xml;base64,AAAA'))
  assert.ok(!needsClick('https://img.game8.co/utzttn7vvo7gdub8b5tr16cmt9bm'))
  assert.ok(!needsClick('https://example.com/a.png?w=800&h=600'))
  assert.ok(needsClick(`https://evil.example/p.png?d=${'x'.repeat(200)}`))
  assert.ok(needsClick(`https://evil.example/${'a'.repeat(150)}.png`))
  assert.ok(needsClick('https://user:pw@example.com/a.png'))
})

test('chat images: local files come back as data: URLs, other files are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-img-'))
  try {
    const png = path.join(dir, 'map.png')
    fs.writeFileSync(png, PNG_1PX)
    assert.equal(localImagePath(png), png)
    assert.equal(localImagePath('/' + png.split(path.sep).join('/')), png)
    assert.equal(localImagePath(path.join(dir, 'run.exe')), undefined)
    assert.match(await chatImage(png), /^data:image\/png;base64,iVBOR/)
    const fake = path.join(dir, 'fake.png')
    fs.writeFileSync(fake, '<svg onload="x()"></svg>')
    await assert.rejects(chatImage(fake))
    await assert.rejects(chatImage('http://example.com/a.png'))
    await assert.rejects(chatImage(42))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
