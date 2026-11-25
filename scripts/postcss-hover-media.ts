// A finger has no hover: on a phone the first tap on an element sets :hover (and keeps it), and when that hover reveals or moves
// something (a row's buttons fading in, a time giving way to a cross) iOS Safari treats the tap as "show the hover" and swallows
// the click, so the user taps twice. This PostCSS plugin moves every :hover rule into @media (hover: hover): a mouse sees exactly
// the same styles, a touch screen never gets the sticky hover. Controls a hover would reveal are shown on touch by explicit
// (hover: none) rules in the stylesheets. Rules already under a hover media query are left alone; a selector list that mixes
// hover and non-hover selectors is split so the non-hover part keeps applying everywhere.

import type { AtRule as AtRuleNode, Container, Node, Plugin, Rule } from 'postcss'

const QUERY = '(hover: hover)'
const HOVER = /:hover(?![\w-])/

/** whether an ancestor at-rule already decides by hover (the author wrote (hover: hover) or (hover: none) on purpose) */
function underHoverQuery(node: Node): boolean {
  for (let p = node.parent as Container | undefined; p; p = p.parent as Container | undefined) {
    if (p.type === 'atrule' && (p as AtRuleNode).name === 'media' && /\bhover\b/.test((p as AtRuleNode).params)) return true
  }
  return false
}

export default function hoverMedia(): Plugin {
  return {
    postcssPlugin: 'jolty-hover-media',
    Once(root, { AtRule }) {
      const made = new WeakSet<Node>()
      const wrap = (rule: Rule): void => {
        const prev = rule.prev()
        // neighbouring hover rules share one wrapper: order is kept and the output stays small
        if (prev && made.has(prev)) {
          (prev as AtRuleNode).append(rule.remove())
          return
        }
        const media = new AtRule({ name: 'media', params: QUERY, source: rule.source })
        made.add(media)
        rule.replaceWith(media)
        media.append(rule)
      }
      const rules: Rule[] = []
      root.walkRules((rule) => {
        if (!HOVER.test(rule.selector)) return
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as AtRuleNode).name)) return
        if (underHoverQuery(rule)) return
        rules.push(rule)
      })
      for (const rule of rules) {
        const all = rule.selectors
        const hover = all.filter((s) => HOVER.test(s))
        const rest = all.filter((s) => !HOVER.test(s))
        if (rest.length === 0) {
          wrap(rule)
          continue
        }
        const copy = rule.clone({ selectors: hover })
        rule.selectors = rest
        rule.after(copy)
        wrap(copy)
      }
    }
  }
}
