import { makeEasing } from './easing';
import {
  NoteType,
  type BpmPointData,
  type BpmSegment,
  type Chart,
  type ChartDataRPE,
  type EventData,
  type EventLayerData,
  type EventTrack,
  type JudgeLine,
  type JudgeLineData,
  type Note,
  type NoteData,
  type SpeedTrack,
  type TimeMap,
  type TimeT,
} from './types';

/** RPE 坐标：速度 1 时音符每秒移动 120 个单位（见格式文档「每个单位代表每秒下降120px」） */
const PX_PER_SPEED_UNIT = 120;

/** visibleTime 大于等于这个值表示音符全程可见 */
const VISIBLE_ALWAYS = 90000;

/** 三元组转拍数 */
export function beatOf(t: TimeT): number {
  return t[0] + t[1] / t[2];
}

export function buildTimeMap(list: BpmPointData[] | undefined): TimeMap {
  const points = (list ?? [])
    .map((p) => ({ beats: beatOf(p.startTime), bpm: p.bpm }))
    .filter((p) => Number.isFinite(p.beats) && p.bpm > 0)
    .sort((a, b) => a.beats - b.beats);

  if (points.length === 0) points.push({ beats: 0, bpm: 120 });
  // 保证 0 拍处一定有 BPM，负数拍由第一段外推
  if (points[0].beats > 0) points.unshift({ beats: 0, bpm: points[0].bpm });

  const segments: BpmSegment[] = [];
  let seconds = 0;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const prev = segments[segments.length - 1];
    if (prev) seconds = prev.seconds + (cur.beats - prev.beats) * (60 / prev.bpm);
    segments.push({ beats: cur.beats, seconds, bpm: cur.bpm });
  }

  const secondsAt = (beats: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].beats <= beats) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    return seg.seconds + (beats - seg.beats) * (60 / seg.bpm);
  };

  const beatsAt = (seconds: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].seconds <= seconds) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    return seg.beats + (seconds - seg.seconds) / (60 / seg.bpm);
  };

  return { segments, secondsAt, beatsAt };
}

/**
 * 把一组事件编译成可快速求值的通道。
 *
 * 求值规则：取最后一个「已经开始」的事件；超过它的 endTime 就取 end 值；
 * 在第一个事件开始之前取第一个事件的 start 值。
 */
function buildTrack(events: EventData[] | undefined, defaultValue: number): EventTrack {
  if (!events || events.length === 0) return { events: [], defaultValue };

  const parsed = events
    .map((e) => {
      const startBeats = beatOf(e.startTime);
      return {
        startBeats,
        endBeats: Math.max(beatOf(e.endTime), startBeats),
        start: e.start,
        end: e.end,
        ease: makeEasing(e),
      };
    })
    .sort((a, b) => a.startBeats - b.startBeats);

  return { events: parsed, defaultValue };
}

export function trackValueAt(track: EventTrack, beats: number): number {
  const events = track.events;
  if (events.length === 0) return track.defaultValue;
  if (beats < events[0].startBeats) return events[0].start;

  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].startBeats <= beats) lo = mid;
    else hi = mid - 1;
  }

  const ev = events[lo];
  if (beats >= ev.endBeats) return ev.end;
  const span = ev.endBeats - ev.startBeats;
  if (span <= 0) return ev.end;
  return ev.start + (ev.end - ev.start) * ev.ease((beats - ev.startBeats) / span);
}

/**
 * 速度值通道。
 *
 * 两个坑：
 * 1. RPE 的速度事件之间是**空档期**，空档里速度保持为上一个事件的结束值，不会爬向下一个事件的起始值。
 *    谱面里很常见「0~1 拍速度 0，然后 103.75 拍才开始有速度」，这中间必须一直是 0。
 * 2. 事件端点处的值是有歧义的（左极限≠右极限）。积分时左端点要取**段内的右极限**、
 *    右端点要取**段内的左极限**，否则会把跳变当成斜坡。
 */
function buildSpeedValueAt(events: EventData[] | undefined, time: TimeMap) {
  if (!events || events.length === 0) return () => 0;

  const parsed = events
    .map((e) => {
      const startBeats = beatOf(e.startTime);
      const endBeats = Math.max(beatOf(e.endTime), startBeats);
      return {
        startBeats,
        endBeats,
        start: e.start,
        end: e.end,
        startSeconds: time.secondsAt(startBeats),
        endSeconds: time.secondsAt(endBeats),
      };
    })
    .sort((a, b) => a.startBeats - b.startBeats);

  /**
   * @param exclusive true 表示只看「起点严格早于 beats」的事件，即取左极限
   */
  return (beats: number, exclusive = false): number => {
    const cmp = (b: number) => (exclusive ? b < beats : b <= beats);

    let lo = -1;
    let hi = parsed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cmp(parsed[mid].startBeats)) lo = mid;
      else hi = mid - 1;
    }

    // 第一个事件开始之前的取值就是它的 start
    if (lo < 0) return parsed[0].start;

    const ev = parsed[lo];
    // 落在空档或事件末尾之后：保持到该事件的结束值
    if (beats >= ev.endBeats) return ev.end;

    const span = ev.endSeconds - ev.startSeconds;
    if (span <= 0) return ev.end;
    // 速度在事件内按时间线性变化
    const t = (time.secondsAt(beats) - ev.startSeconds) / span;
    return ev.start + (ev.end - ev.start) * t;
  };
}

/**
 * 构造判定线的 floor position 通道。
 *
 * floor position 是「音符在这条判定线上已经走过的距离」，单位是 RPE 坐标：
 *   F(b) = 120 × ∫₀^{t(b)} S(τ) dτ
 *
 * 速度在每两个速度事件之间随时间线性变化，所以把时间轴按「速度事件边界 + BPM 变化点」
 * 切成若干段之后，每段内 F 就是拍数的二次函数，可以精确求值而不必数值积分。
 */
function buildSpeedTrack(
  events: EventData[] | undefined,
  time: TimeMap,
  endBeats: number,
): SpeedTrack {
  const speedValueAt = buildSpeedValueAt(events, time);

  const breakpoints = new Set<number>([0, endBeats]);
  for (const e of events ?? []) {
    breakpoints.add(beatOf(e.startTime));
    breakpoints.add(Math.max(beatOf(e.endTime), beatOf(e.startTime)));
  }
  // BPM 变化点也要切开，段内每拍秒数才是常数
  for (const seg of time.segments) breakpoints.add(seg.beats);

  const bounds = [...breakpoints].filter((b) => Number.isFinite(b) && b >= 0).sort((a, b) => a - b);

  const segments: {
    b0: number;
    b1: number;
    f0: number;
    s0: number;
    s1: number;
    spb: number;
  }[] = [];
  let floor = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const b0 = bounds[i];
    const b1 = bounds[i + 1];
    if (!(b1 > b0)) continue;
    // 段内的值：左端点取右极限，右端点取左极限
    const s0 = speedValueAt(b0, false);
    const s1 = speedValueAt(b1, true);
    const spb = (time.secondsAt(b1) - time.secondsAt(b0)) / (b1 - b0);
    segments.push({ b0, b1, f0: floor, s0, s1, spb });
    floor += PX_PER_SPEED_UNIT * spb * (b1 - b0) * ((s0 + s1) / 2);
  }

  // 最后补一段速度恒定的尾巴，让超过谱面末尾的求值也能精确外推
  const last = segments[segments.length - 1];
  if (last) {
    const tailStart = last.b1;
    const s = speedValueAt(tailStart, false);
    const spb = 60 / time.segments[time.segments.length - 1].bpm;
    segments.push({ b0: tailStart, b1: tailStart + 1024, f0: floor, s0: s, s1: s, spb });
  } else {
    segments.push({ b0: 0, b1: 1024, f0: 0, s0: 0, s1: 0, spb: 0.5 });
  }

  const floorAt = (beats: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].b0 <= beats) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    const dx = beats - seg.b0;
    const k = (seg.s1 - seg.s0) / (seg.b1 - seg.b0);
    return seg.f0 + PX_PER_SPEED_UNIT * seg.spb * (seg.s0 * dx + (k * dx * dx) / 2);
  };

  return { segments, floorAt };
}

function parseNote(
  data: NoteData,
  time: TimeMap,
): Note {
  const startBeats = beatOf(data.startTime);
  const endBeats = Math.max(beatOf(data.endTime), startBeats);
  const visibleTime = data.visibleTime;

  const visibleBeats =
    visibleTime === undefined || visibleTime === null || visibleTime >= VISIBLE_ALWAYS
      ? Infinity
      : time.beatsAt(time.secondsAt(startBeats) - visibleTime);

  return {
    type: data.type as NoteType,
    startBeats,
    endBeats,
    positionX: data.positionX ?? 0,
    yOffset: data.yOffset ?? 0,
    speed: data.speed ?? 1,
    size: data.size ?? 1,
    // 实测数据里 1 表示上方；文档注明 2 表示下方，0 也按下处理
    above: data.above === 1,
    alpha: (data.alpha ?? 255) / 255,
    isFake: data.isFake === 1,
    visibleBeats,
  };
}

/** 把多层事件层叠加起来。空层（null）跳过。 */
function stackedTrack(
  layers: readonly (EventLayerData | null)[],
  key: keyof EventLayerData,
  defaultValue: number,
): EventTrack {
  const all: EventData[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    const events = layer[key];
    if (events) all.push(...events);
  }
  return buildTrack(all, defaultValue);
}

export function parseChart(data: ChartDataRPE): Chart {
  const time = buildTimeMap(data.BPMList);
  const rawLines = data.judgeLineList ?? [];

  // 先算出谱面实际结束拍数，用于给速度通道收尾
  let endBeats = 0;
  for (const line of rawLines) {
    for (const e of line.eventLayers ?? []) {
      if (!e) continue;
      for (const key of [
        'alphaEvents',
        'moveXEvents',
        'moveYEvents',
        'rotateEvents',
        'speedEvents',
      ] as const) {
        for (const ev of e[key] ?? []) {
          endBeats = Math.max(endBeats, beatOf(ev.endTime));
        }
      }
    }
    for (const n of line.notes ?? []) {
      endBeats = Math.max(endBeats, beatOf(n.endTime));
    }
  }
  endBeats += 1;

  const lines: JudgeLine[] = [];
  const lineIndexById = new Map<number, number>();
  let maxCombo = 0;
  let totalNotes = 0;

  rawLines.forEach((raw: JudgeLineData, index: number) => {
    const layers = raw.eventLayers ?? [];

    const notes = (raw.notes ?? [])
      .map((n) => parseNote(n, time))
      .sort((a, b) => a.startBeats - b.startBeats || a.positionX - b.positionX);

    for (const note of notes) {
      totalNotes++;
      if (!note.isFake) maxCombo++;
    }

    lines.push({
      id: index,
      name: raw.Name ?? `line ${index}`,
      zOrder: raw.zOrder ?? 0,
      isCover: raw.isCover === 1,
      father: raw.father ?? -1,
      anchor: raw.anchor ?? [0.5, 0.5],
      // alpha 缺省是满不透明（255），其余通道缺省是 0
      alpha: stackedTrack(layers, 'alphaEvents', 255),
      moveX: stackedTrack(layers, 'moveXEvents', 0),
      moveY: stackedTrack(layers, 'moveYEvents', 0),
      rotate: stackedTrack(layers, 'rotateEvents', 0),
      speed: buildSpeedTrack(
        layers.flatMap((l) => (l?.speedEvents ? l.speedEvents : [])),
        time,
        endBeats,
      ),
      notes,
    });
    lineIndexById.set(index, index);
  });

  const durationBeats = endBeats;
  const durationSeconds = time.secondsAt(durationBeats);

  return {
    meta: {
      name: data.META?.name ?? 'untitled',
      level: data.META?.level ?? '',
      composer: data.META?.composer ?? '',
      charter: data.META?.charter ?? '',
      illustrator: data.META?.illustrator ?? '',
      // RPE 的 offset 单位是毫秒
      offset: (data.META?.offset ?? 0) / 1000,
    },
    time,
    lines,
    lineIndexById,
    maxCombo,
    totalNotes,
    totalBeats: durationBeats,
    durationSeconds,
  };
}
