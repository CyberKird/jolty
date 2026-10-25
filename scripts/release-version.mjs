// The version rule, checked before a release: a section with "### New" bumps the minor, anything else only the patch.
const parse = (v) => v.split('.').map(Number)

/** The reason this version does not fit after `prev` for these notes, or undefined when it does. */
export function versionProblem(prev, next, notes) {
  const [pa, pb, pc] = parse(prev)
  const [na, nb, nc] = parse(next)
  if ([...parse(prev), ...parse(next)].some(Number.isNaN)) return `"${prev}" or "${next}" is not a version like 1.2.3`
  const feature = /^### New\s*$/m.test(notes)
  if (na !== pa) return undefined // a new major is the user's call
  if (feature) return nb === pb + 1 && nc === 0 ? undefined : `the notes have "### New", so after ${prev} the version must be ${pa}.${pb + 1}.0, not ${next}`
  return nb === pb && nc === pc + 1 ? undefined : `the notes have no "### New" (fixes only), so after ${prev} the version must be ${pa}.${pb}.${pc + 1}, not ${next}`
}
