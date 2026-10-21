/** CHANGELOG.md as the What's new window reads it: releases newest first, each with its sections and items. */
export interface ChangeItem {
  /** the item's lead sentence, shown bold; empty when it does not read as one */
  title: string
  body: string
}
export interface ChangeGroup {
  /** "New", "Fixes"... from a ### heading; empty for releases written as one plain list */
  name: string
  items: ChangeItem[]
}
export interface Release {
  version: string
  groups: ChangeGroup[]
}

/** "Lead sentence. The rest" or "Lead: the rest": a short lead becomes the title. */
export function splitLead(text: string): ChangeItem {
  const m = /[.:](?=\s)/.exec(text)
  if (!m || m.index > 140) return { title: '', body: text }
  const body = text.slice(m.index + 1).trim()
  // "Lead: the rest" reads as two sentences once split
  return { title: text.slice(0, m.index), body: body.charAt(0).toUpperCase() + body.slice(1) }
}

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = []
  let item: string[] | null = null
  const flush = (): void => {
    if (item) releases.at(-1)?.groups.at(-1)?.items.push(splitLead(item.join(' ')))
    item = null
  }
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^##\s+(\S+)/.exec(line))) {
      flush()
      releases.push({ version: m[1], groups: [{ name: '', items: [] }] })
    } else if (!releases.length) continue
    else if ((m = /^###\s+(.+)/.exec(line))) {
      flush()
      releases.at(-1)!.groups.push({ name: m[1].trim(), items: [] })
    } else if ((m = /^[-*]\s+(.*)/.exec(line)) && !/^\s{2,}/.test(raw)) {
      flush()
      item = [m[1]]
    } else if (!line) flush()
    else item?.push(line)
  }
  flush()
  return releases.map((r) => ({ ...r, groups: r.groups.filter((g) => g.items.length) }))
}
