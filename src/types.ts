import type { CueTiming } from './timing'

export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
  /** 挂点规则；旧数据（v1）没有该字段，加载时补成顺接上一条。 */
  timing?: CueTiming
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
}

export interface PendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  note: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

export interface StudioState {
  /** 本地数据版本：1 为旧的纯顺序稿，加载时升级为 2 并补全顺接挂点。 */
  version?: number
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

export type WarningType = 'collision' | 'missing-sfx' | 'over-time' | 'dangling-target' | 'timing-cycle' | 'crossed-fixed'

export interface WarningItem {
  id: string
  type: WarningType
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
  /** 阻断导出的时间线错误（缺依赖、循环、越固定点）。 */
  blocking?: boolean
}
