// Tool input arrives as JSON in pieces while the model writes it; these read what is there so far,
// so a file being written or edited can be shown live, line by line.

/** Pulls a (possibly still incomplete) string field out of streamed tool-input JSON. */
export function partialJsonString(json: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json)
  return m ? readString(json, m.index + m[0].length) : undefined
}

/** Every value of `key` (MultiEdit has one per edit), the last one possibly still arriving. */
export function partialJsonStrings(json: string, key: string): string[] {
  const out: string[] = []
  const re = new RegExp(`"${key}"\\s*:\\s*"`, 'g')
  for (let m = re.exec(json); m; m = re.exec(json)) out.push(readString(json, m.index + m[0].length))
  return out
}

/** An edit as it streams in, drawn as a diff: the lines it replaces, then the lines it writes. */
export function editDiff(json: string): string {
  const olds = partialJsonStrings(json, 'old_string')
  const news = partialJsonStrings(json, 'new_string')
  return olds
    .map((o, i) => [`@@ modificarea ${i + 1}`, ...o.split('\n').map((l) => `-${l}`), ...(news[i] ? news[i].split('\n').map((l) => `+${l}`) : [])].join('\n'))
    .join('\n')
}

function readString(json: string, start: number): string {
  let i = start
  let raw = ''
  while (i < json.length) {
    const c = json[i]
    if (c === '\\') {
      if (i + 1 >= json.length) break
      if (json[i + 1] === 'u' && i + 5 >= json.length) break
      raw += json.slice(i, json[i + 1] === 'u' ? i + 6 : i + 2)
      i += json[i + 1] === 'u' ? 6 : 2
      continue
    }
    if (c === '"') break
    raw += c
    i++
  }
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}
