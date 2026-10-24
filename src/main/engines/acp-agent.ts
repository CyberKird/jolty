import type { ModelOption, PermissionMode } from '@shared/types'
import { tr } from '@shared/i18n'
import type { JsonRpcProcess } from './jsonrpc'
import { launchHermes } from './hermes-runtime'
import { launchOpencode, opencodeVariants } from './opencode-runtime'
import { list, object, str, type AcpObject } from './acp-events'

/** What differs between the external agents Jolty drives over ACP (Hermes, OpenCode). */
export interface AcpAgent {
  engine: 'hermes' | 'opencode'
  name: string
  launch(mode: PermissionMode, browser: boolean, computer: boolean): JsonRpcProcess
  /** whether the Jolty browser and computer use can be attached to a conversation */
  browser: boolean
  /** the agent's own mode id for a Jolty permission mode; throws when the agent cannot do it */
  modeId(mode: PermissionMode): string
  /** the approval option that lasts for the conversation only, never a permanent one */
  sessionAllow(option: AcpObject): boolean
  /** approvals are fixed when the process starts, so a new permission mode needs a fresh process */
  restartOnMode: boolean
  currentModel(state: AcpObject): string
  models(state: AcpObject): ModelOption[]
  setModel(rpc: JsonRpcProcess, sessionId: string, model: string): Promise<unknown>
  setMode(rpc: JsonRpcProcess, sessionId: string, modeId: string): Promise<unknown>
  /** sets the thinking level of the current model; agents without it keep it in their own configuration */
  setEffort?(rpc: JsonRpcProcess, sessionId: string, effort: string): Promise<unknown>
  /** adds what the session response does not list, such as each model's thinking levels */
  enrich?(models: ModelOption[]): Promise<ModelOption[]>
  /** the project's own compaction command, if it has one */
  compactCommand?: string
}

export const HERMES: AcpAgent = {
  engine: 'hermes',
  name: 'Hermes',
  launch: () => launchHermes(),
  browser: false,
  modeId(mode) {
    if (mode === 'plan') throw new Error(tr("Hermes ACP nu oferă un mod Plan protejat. Alege aprobarea editărilor."))
    return mode === 'autoEdit' ? 'accept_edits' : mode === 'full' ? 'dont_ask' : 'default'
  },
  sessionAllow: (o) => o.optionId === 'allow_session',
  restartOnMode: false,
  currentModel: (state) => str(object(state.models).currentModelId),
  models(state) {
    const models = object(state.models)
    return list(models.availableModels).filter((m) => typeof m.modelId === 'string').map((m) => ({
      id: m.modelId, label: str(m.name) || m.modelId, description: str(m.description), isDefault: m.modelId === models.currentModelId, vision: true
    }))
  },
  setModel: (rpc, sessionId, modelId) => rpc.request('session/set_model', { sessionId, modelId }),
  setMode: (rpc, sessionId, modeId) => rpc.request('session/set_mode', { sessionId, modeId }),
  compactCommand: '/compact'
}

// opencode lists every model of every provider it knows, including image, speech and safety models
const NOT_CHAT = /embed|rerank|flux|image|whisper|tts|guard|safety|voice|detector|paligemma|bevformer|streampetr|sparsedrive|cosmos|studiovoice|speaker|magpie|diffusion|moderation/i
const FREE = /^opencode\/(big-pickle|.*-free)$/

function configOption(state: AcpObject, id: string): AcpObject {
  return list(state.configOptions).find((o) => o.id === id) || {}
}

export const OPENCODE: AcpAgent = {
  engine: 'opencode',
  name: 'OpenCode',
  launch: (mode, browser, computer) => launchOpencode(mode, browser, computer),
  browser: true,
  modeId: (mode) => mode === 'plan' ? 'plan' : 'build',
  // opencode keeps an "always" answer in memory for the running process, not on disk
  sessionAllow: (o) => o.kind === 'allow_always',
  restartOnMode: true,
  currentModel: (state) => str(configOption(state, 'model').currentValue),
  models(state) {
    const option = configOption(state, 'model')
    const models = list(option.options)
      .filter((m) => typeof m.value === 'string' && !NOT_CHAT.test(m.value))
      .map((m): ModelOption => ({
        id: m.value, label: str(m.name) || m.value, vision: true, isDefault: m.value === option.currentValue,
        description: FREE.test(m.value) ? tr("Gratuit prin OpenCode") : undefined
      }))
    return [...models.filter((m) => FREE.test(m.id)), ...models.filter((m) => !FREE.test(m.id))]
  },
  setModel: (rpc, sessionId, value) => rpc.request('session/set_config_option', { sessionId, configId: 'model', value }),
  setMode: (rpc, sessionId, value) => rpc.request('session/set_config_option', { sessionId, configId: 'mode', value }),
  // the level list is per model and only exists once the model is selected; "default" is opencode's own choice
  setEffort: (rpc, sessionId, effort) => rpc.request('session/set_config_option', { sessionId, configId: 'effort', value: effort || 'default' }),
  async enrich(models) {
    const levels = await opencodeVariants().catch(() => new Map<string, string[]>())
    return models.map((m) => (levels.get(m.id)?.length ? { ...m, efforts: levels.get(m.id) } : m))
  }
}

export const AGENTS = { hermes: HERMES, opencode: OPENCODE } as const
