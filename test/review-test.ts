import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineNumbers, markOf, reviewMessage, type ReviewComment } from '../src/shared/review'

test('a unified diff numbers its new-file lines from the hunk header, removed lines get none', () => {
  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -3,3 +10,3 @@', ' keep', '-old', '+new', ' tail', '@@ -40,1 +50,1 @@', '+later'].join('\n')
  assert.deepEqual(lineNumbers(diff), [undefined, undefined, undefined, 10, undefined, 11, 12, undefined, 50])
})

test('the plain -/+ diffs of an edit have no numbers at all', () => {
  assert.deepEqual(lineNumbers('-a\n+b\n@@\n-c\n+d'), [undefined, undefined, undefined, undefined, undefined])
})

test('the mark of a line is read from its first character', () => {
  assert.deepEqual(['+x', '-x', ' x', 'x'].map(markOf), ['+', '-', ' ', ' '])
})

const c = (path: string, mark: ReviewComment['mark'], code: string, text: string, line?: number): ReviewComment => ({ id: path + code, at: '0:0', path, line, mark, code, text })

test('the message groups the comments by file, quotes the line and keeps the order', () => {
  const msg = reviewMessage(
    [c('src/a.ts', '+', '+const x = 1', 'rename it', 12), c('src/b.ts', '-', '-foo()', ' why remove?  '), c('src/a.ts', ' ', ' return x', 'dead code')],
    'Review:'
  )
  assert.equal(
    msg,
    ['Review:', '', 'src/a.ts:12', '> +const x = 1', 'rename it', '', 'src/a.ts', '> return x', 'dead code', '', 'src/b.ts', '> -foo()', 'why remove?'].join('\n')
  )
})
