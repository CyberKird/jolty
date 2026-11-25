// scripts/postcss-hover-media.ts: every :hover rule ends up under @media (hover: hover), nothing else moves, and a rule that mixes
// hover and non-hover selectors keeps its non-hover part for every screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import postcss from 'postcss'
import hoverMedia from '../scripts/postcss-hover-media'

/** whitespace does not matter to the comparison */
const flat = (css: string): string => css.replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1').trim()
const run = (css: string): string => flat(postcss([hoverMedia()]).process(css, { from: undefined }).css)

test('a :hover rule is wrapped, a plain rule is not', () => {
  assert.equal(run('.a { color: red } .a:hover { color: blue }'), flat('.a { color: red } @media (hover: hover) { .a:hover { color: blue } }'))
})

test('neighbouring hover rules share one wrapper and keep their order', () => {
  assert.equal(run('.a:hover { x: 1 } .b:hover .c { x: 2 } .d { x: 3 } .e:hover { x: 4 }'), flat('@media (hover: hover) { .a:hover { x: 1 } .b:hover .c { x: 2 } } .d { x: 3 } @media (hover: hover) { .e:hover { x: 4 } }'))
})

test('a mixed selector list is split: focus and plain selectors stay for touch', () => {
  assert.equal(run('.row:hover .del, .del:focus-visible { opacity: 1 }'), flat('.del:focus-visible { opacity: 1 } @media (hover: hover) { .row:hover .del { opacity: 1 } }'))
})

test('rules inside other at-rules are wrapped where they are', () => {
  assert.equal(run('@media (max-width: 760px) { html.remote .x:hover .t { p: 1 } }'), flat('@media (max-width: 760px) { @media (hover: hover) { html.remote .x:hover .t { p: 1 } } }'))
  assert.equal(run('@supports (display: grid) { .x:hover { p: 1 } }'), flat('@supports (display: grid) { @media (hover: hover) { .x:hover { p: 1 } } }'))
  assert.equal(run('@layer base { .x:hover { p: 1 } }'), flat('@layer base { @media (hover: hover) { .x:hover { p: 1 } } }'))
})

test('a rule the author already put under a hover query is left alone', () => {
  const css = '@media (hover: hover) { .a:hover { x: 1 } } @media (hover: none) { .a:hover { x: 2 } }'
  assert.equal(run(css), flat(css))
})

test('pseudo-elements and :not() after :hover are hover rules; :hovered-like names are not', () => {
  assert.equal(run('.cv:hover::before { o: 1 }'), flat('@media (hover: hover) { .cv:hover::before { o: 1 } }'))
  assert.equal(run('.i:hover:not(:disabled) { o: 1 }'), flat('@media (hover: hover) { .i:hover:not(:disabled) { o: 1 } }'))
  assert.equal(run('.x:hover-thing { o: 1 }'), flat('.x:hover-thing { o: 1 }'))
})
