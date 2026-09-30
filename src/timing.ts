import type { Cue, Scene, StudioDocument } from './types'

export type TimingMode = 'after' | 'follow' | 'absolute'
export type FollowAnchor = 'start' | 'end'

/**
 * 提示挂点：
 * - after：顺接上一条（列表前一项结束即开始；整场第一条从 0 开始）
 * - follow：跟随指定提示，从其起点/终点再加 offset 秒（offset 可为负）
 * - absolute：固定在本场第 at 秒，不被上游改动推动，同时挡住传播
 */
export interface CueTiming {
  mode: TimingMode
  targetId?: string
  anchor?: FollowAnchor
  offset?: number
  at?: number
}

export type TimelineErrorCode = 'dangling-target' | 'timing-cycle' | 'crossed-fixed'

export interface TimelineError {
  code: TimelineErrorCode
  sceneId: string
  cueId: string
  cueLabel: string
  message: string
}

export interface TimedCue {
  cueId: string
  index: number
  start: number
  end: number
  duration: number
  /** 本提示的起点是否被固定秒点钉住（absolute 模式）。 */
  pinned: boolean
  /** 实际生效的依赖目标（after 模式为列表前一条，首条为 null）。 */
  sourceId: string | null
  timing: CueTiming
}

export interface SceneTimeline {
  sceneId: string
  cues: TimedCue[]
  /** 所有提示结束点的最大值，即场次时长。 */
  duration: number
  errors: TimelineError[]
}

export interface DocumentTimeline {
  scenes: SceneTimeline[]
  errors: TimelineError[]
  duration: number
}

export const DEFAULT_TIMING: CueTiming = { mode: 'after' }

export function cueLabel(cue: Cue): string {
  if (cue.kind === 'dialogue') return `台词“${cue.text.slice(0, 12)}${cue.text.length > 12 ? '…' : ''}”`
  if (cue.kind === 'sfx') return `音效“${cue.text.slice(0, 12)}${cue.text.length > 12 ? '…' : ''}”`
  return `转场“${cue.text.slice(0, 12)}${cue.text.length > 12 ? '…' : ''}”`
}

const round1 = (value: number) => Number(value.toFixed(3))

/**
 * 计算单场时间线。
 *
 * 依赖图：每条非固定提示依赖唯一来源（after → 列表前一条；follow → 指定提示）。
 * 用记忆化 DFS 求值：上游先算，固定点自身不访问任何来源，因此传播在固定点处断开。
 * DFS 同时发现悬空依赖与循环。全部求值后再检查“越过固定秒点”。
 */
export function resolveSceneTimeline(
  scene: Scene,
  durationOf: (cue: Cue) => number
): SceneTimeline {
  const errors: TimelineError[] = []
  const byIndex = new Map<string, number>()
  scene.cues.forEach((cue, index) => byIndex.set(cue.id, index))
  const starts = new Map<string, number>()
  const durations = new Map<string, number>()
  const sourceMap = new Map<string, string | null>()

  for (const cue of scene.cues) {
    durations.set(cue.id, Math.max(0, durationOf(cue)))
  }

  function sourceOf(cue: Cue, index: number): string | null {
    if (sourceMap.has(cue.id)) return sourceMap.get(cue.id) ?? null
    const timing = cue.timing ?? DEFAULT_TIMING
    let source: string | null = null
    if (timing.mode === 'follow') {
      if (timing.targetId && byIndex.has(timing.targetId)) {
        source = timing.targetId
      } else {
        errors.push({
          code: 'dangling-target',
          sceneId: scene.id,
          cueId: cue.id,
          cueLabel: cueLabel(cue),
          message: `${cueLabel(cue)}设置为跟随指定提示，但依赖提示已被删除，导出已停止。请重新选择跟随对象或改为顺接。`
        })
      }
    } else if (timing.mode === 'after') {
      source = index > 0 ? scene.cues[index - 1].id : null
    }
    // absolute：无来源，传播在此断开。
    sourceMap.set(cue.id, source)
    return source
  }

  scene.cues.forEach((cue, index) => sourceOf(cue, index))

  // 沿依赖链找环：每条链用栈记录，再次遇到栈中节点时，
  // 从该节点到栈顶的整段都属于环，全部标为循环提示。
  const inCycle = new Set<string>()
  for (const root of scene.cues) {
    const stack: string[] = []
    let current: string | null = root.id
    while (current) {
      const hit = stack.indexOf(current)
      if (hit >= 0) {
        for (const id of stack.slice(hit)) inCycle.add(id)
        break
      }
      if (inCycle.has(current)) break
      stack.push(current)
      current = sourceMap.get(current) ?? null
    }
  }
  for (const cueId of inCycle) {
    const cue = scene.cues[byIndex.get(cueId)!]
    errors.push({
      code: 'timing-cycle',
      sceneId: scene.id,
      cueId,
      cueLabel: cueLabel(cue),
      message: `${cueLabel(cue)}与跟随提示形成了循环依赖，时间无法确定，导出已停止。请打断循环后重试。`
    })
  }

  function startOf(index: number): number {
    const cue = scene.cues[index]
    const cached = starts.get(cue.id)
    if (cached !== undefined) return cached
    if (inCycle.has(cue.id)) {
      // 环上节点无法确定起点，按 0 兜底以保证页面其余部分仍可渲染。
      starts.set(cue.id, 0)
      return 0
    }

    const timing = cue.timing ?? DEFAULT_TIMING
    let start: number
    if (timing.mode === 'absolute') {
      start = Math.max(0, Number(timing.at ?? 0))
    } else {
      const sourceId = sourceMap.get(cue.id) ?? null
      if (sourceId === null) {
        // 悬空依赖与整场首条一样从 0 起；悬空已单独报错。
        start = 0
      } else {
        const sourceCue = scene.cues[byIndex.get(sourceId)!]
        const sourceStart = startOf(byIndex.get(sourceId)!)
        if (timing.mode === 'after') {
          start = sourceStart + (durations.get(sourceCue.id) ?? 0)
        } else {
          const anchor = timing.anchor ?? 'end'
          const base = anchor === 'start' ? sourceStart : sourceStart + (durations.get(sourceCue.id) ?? 0)
          start = base + Number(timing.offset ?? 0)
        }
      }
    }
    start = round1(Math.max(0, start))
    starts.set(cue.id, start)
    return start
  }

  scene.cues.forEach((cue, index) => {
    if (!inCycle.has(cue.id)) startOf(index)
  })

  // 越过固定秒点：某条非固定提示在列表中排在固定点之前，
  // 重算后起点却落到该固定点的绝对秒点之后（起点重合不算越过）。
  const fixed: Array<{ index: number; at: number; cue: Cue }> = []
  scene.cues.forEach((cue, index) => {
    if ((cue.timing ?? DEFAULT_TIMING).mode === 'absolute') {
      fixed.push({ index, at: Math.max(0, Number(cue.timing?.at ?? 0)), cue })
    }
  })
  for (const cue of scene.cues) {
    const index = byIndex.get(cue.id)!
    const timing = cue.timing ?? DEFAULT_TIMING
    if (timing.mode === 'absolute') continue
    const start = starts.get(cue.id) ?? 0
    for (const pin of fixed) {
      if (index < pin.index && round1(start) > round1(pin.at)) {
        errors.push({
          code: 'crossed-fixed',
          sceneId: scene.id,
          cueId: cue.id,
          cueLabel: cueLabel(cue),
          message: `${cueLabel(cue)}重算后起点为 ${start.toFixed(1)}s，越过了后面固定在 ${pin.at.toFixed(1)}s 的${cueLabel(pin.cue)}，固定秒点被冲破，导出已停止。`
        })
        break
      }
    }
  }

  const timed: TimedCue[] = scene.cues.map((cue, index) => {
    const duration = durations.get(cue.id) ?? 0
    const start = starts.get(cue.id) ?? 0
    return {
      cueId: cue.id,
      index,
      start,
      end: round1(start + duration),
      duration,
      pinned: (cue.timing ?? DEFAULT_TIMING).mode === 'absolute',
      sourceId: sourceMap.get(cue.id) ?? null,
      timing: cue.timing ?? DEFAULT_TIMING
    }
  })

  const duration = round1(timed.reduce((max, item) => Math.max(max, item.end), 0))
  return { sceneId: scene.id, cues: timed, duration, errors }
}

export function resolveDocumentTimeline(
  document: StudioDocument,
  durationOf: (cue: Cue) => number
): DocumentTimeline {
  const scenes = document.scenes.map((scene) => resolveSceneTimeline(scene, durationOf))
  return {
    scenes,
    errors: scenes.flatMap((scene) => scene.errors),
    duration: round1(scenes.reduce((total, scene) => total + scene.duration, 0))
  }
}
