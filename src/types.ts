export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

/**
 * 挂点（提示起点）三种接法：
 * - prev：接上一条。起点 = 上一条的结束点 + offset（offset 为结束后再等待的秒数，0 即紧接）。
 * - follow：跟随本场内指定提示。起点 = 目标（开始或结束）点 + offset；
 *   from 'start' 且 offset 0 表示与目标同时起，from 'end' 表示等目标结束再等 offset 秒。
 * - absolute：固定绝对秒点。不依赖任何提示，时间变化不会越过它传播。
 */
export interface PrevAnchor {
  mode: 'prev'
  offset: number
}
export interface FollowAnchor {
  mode: 'follow'
  targetId: string
  from: 'start' | 'end'
  offset: number
}
export interface AbsoluteAnchor {
  mode: 'absolute'
  time: number
}
export type CueAnchor = PrevAnchor | FollowAnchor | AbsoluteAnchor

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
  anchor: CueAnchor
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
  version: number
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
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

/** 排程错误：依赖脱落（跟随目标不存在）、循环挂接、重算越过固定秒点。 */
export type ScheduleIssueType = 'dangling' | 'cycle' | 'cross-fixed'

export interface ScheduleIssue {
  type: ScheduleIssueType
  cueId: string
  /** dangling：已丢失的目标 id；cycle：参与循环的其余提示；cross-fixed：被越过的固定秒点提示。 */
  relatedIds: string[]
  /** 当前重算出的时间（若可得）。 */
  at?: number
  /** 固定秒点时间（cross-fixed 时给出）。 */
  fixedTime?: number
}

export interface CueTiming {
  start: number
  end: number
  /** 因脱落/循环无法求解的提示没有时间。 */
  resolved: boolean
}

export interface SceneSchedule {
  timing: Record<string, CueTiming>
  duration: number
  issues: ScheduleIssue[]
  blocked: boolean
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time' | 'schedule'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}
