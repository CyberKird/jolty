// The "send with parallel sessions" action: the message is shown as written, the model also gets this
// instruction in front. Kept in English whatever the interface language, it is for the model only.

export const PARALLEL_INSTRUCTION =
  '[The user sent this with the parallel button: split the job into independent parts and run them with start_session (one brief each, self-contained), wait_for_sessions, then merge the branches yourself. Only do it if the job really has independent parts; otherwise say so and do it yourself.]'

export function withParallelInstruction(prompt: string): string {
  return `${PARALLEL_INSTRUCTION}\n\n${prompt}`
}
