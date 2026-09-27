// Claude Code's task list: TaskCreate / TaskUpdate / TaskList (current) and TodoWrite (older
// versions), folded into the plan steps Jolty shows above the composer and in the Plan tab.
import type { PlanStep } from '@shared/types'

type Status = 'pending' | 'in_progress' | 'completed'

interface Task {
  subject: string
  activeForm?: string
  status: Status
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class TaskBoard {
  private tasks = new Map<string, Task>()

  /** TaskCreate's result carries the new id: structured output first, then the "#12" in its text. */
  created(input: any, output: any, text: string): void {
    const id = String(output?.task?.id ?? /#?(\d+)/.exec(text)?.[1] ?? '')
    const subject = String(input?.subject ?? output?.task?.subject ?? '').trim()
    if (id && subject) this.tasks.set(id, { subject, activeForm: input?.activeForm, status: 'pending' })
  }

  /** TaskUpdate is applied as soon as the model calls it, so the list moves with the work. */
  updated(input: any): void {
    const id = String(input?.taskId ?? '')
    const t = this.tasks.get(id)
    if (!t) return
    if (input.status === 'deleted') {
      this.tasks.delete(id)
      return
    }
    if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') t.status = input.status
    if (typeof input.subject === 'string' && input.subject.trim()) t.subject = input.subject.trim()
    if (typeof input.activeForm === 'string') t.activeForm = input.activeForm
  }

  /** TaskList's result is the whole truth: rebuild from it, keeping known active forms. */
  listed(output: any): void {
    if (!Array.isArray(output?.tasks)) return
    const next = new Map<string, Task>()
    for (const t of output.tasks) {
      const id = String(t?.id ?? '')
      if (!id || !t?.subject) continue
      next.set(id, { subject: String(t.subject), activeForm: this.tasks.get(id)?.activeForm, status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending' })
    }
    this.tasks = next
  }

  /** TodoWrite sends the complete list every time. */
  todos(list: any[]): void {
    this.tasks = new Map(
      list.map((td, i) => [String(i), { subject: String(td?.content ?? ''), activeForm: td?.activeForm, status: td?.status === 'completed' || td?.status === 'in_progress' ? td.status : 'pending' }])
    )
  }

  steps(): PlanStep[] {
    return [...this.tasks.values()].map((t) => ({
      text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject,
      status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending'
    }))
  }
}
