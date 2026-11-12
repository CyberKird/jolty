/**
 * Models whose refusals were removed or never added (abliterated, heretic, "uncensored" and de-aligned builds), told apart by
 * the name the provider gives them. Only a hint for the picker, never a safety decision.
 */
export const isUncensored = (id: string | undefined): boolean => Boolean(id && /abliterat|heretic|uncensored|dealign/i.test(id))
