import { Fragment, type ReactNode } from 'react'

/**
 * A translated sentence with React parts (bold names) where its {placeholders} are, so word order
 * stays the translator's: <Trans text={tr('În {folder}, cu {profile}.')} values={{ folder: <b>x</b> }} />
 */
export function Trans({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  return (
    <>
      {text.split(/(\{\w+\})/).map((part, i) => {
        const m = /^\{(\w+)\}$/.exec(part)
        return <Fragment key={i}>{m && m[1] in values ? values[m[1]] : part}</Fragment>
      })}
    </>
  )
}
