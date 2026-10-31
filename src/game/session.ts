import { NoteType, type Chart, type Note } from '../chart/types';
import type { TapInput } from './input';
import { Grade, GRADE_ACCURACY, JUDGMENT, rankOf } from './judgment';

/**
 * 一局游戏的判定状态机。
 *
 * 所有时间都是「谱面时间」（秒），也就是歌曲时间减去谱面自己的 offset；
 * 时间轴方向只前进，倒着走（比如拖动进度条）必须调用 reset()。
 *
 * 几个我做的判断，觉得不对可以直接改：
 * - 长按在**头部**就出评级和连击，中途松手则退回成 Miss 并断连击
 * - Drag 音符不需要点，判定窗口内只要屏幕上有手指按着就算 Perfect
 * - Flick 必须真的有滑动动作（见 JUDGMENT.flickRequiresGesture）
 */

export interface NoteRuntime {
  /** 头部已经被判定过（长按也算） */
  readonly resolved: boolean;
  readonly grade: Grade;
  /** 判定发生的时刻，渲染层用它来播打击特效 */
  readonly resolvedAt: number;
  /** 长按头部已命中、正在按住 */
  readonly holding: boolean;
  /** 长按中途断了 */
  readonly broken: boolean;
}

export interface JudgeNote extends NoteRuntime {
  note: Note;
  lineIndex: number;
  hitSeconds: number;
  endSeconds: number;
  resolved: boolean;
  grade: Grade;
  resolvedAt: number;
  holding: boolean;
  broken: boolean;
  /** 最近一次检测到手指还按着的时刻，用于宽限 */
  lastHeldAt: number;
}

export interface SessionStats {
  perfect: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
  judged: number;
  total: number;
  score: number;
  accuracy: number;
  rank: string;
}

export class PlaySession {
  private notes: JudgeNote[] = [];
  private readonly byNote = new Map<Note, JudgeNote>();
  /** 第一个还没走完判定窗口的音符下标 */
  private cursor = 0;
  private readonly holding = new Set<JudgeNote>();

  private perfect = 0;
  private good = 0;
  private miss = 0;
  private combo = 0;
  private maxCombo = 0;
  /** 所有音符总数，只算要判定的（fake 不算） */
  private total = 0;

  /** 最近一次判定的结果，供 HUD 显示 */
  lastGrade: Grade | null = null;
  lastGradeAt = 0;

  setChart(chart: Chart): void {
    this.notes = [];
    this.byNote.clear();

    for (let lineIndex = 0; lineIndex < chart.lines.length; lineIndex++) {
      const line = chart.lines[lineIndex];
      for (const note of line.notes) {
        // 假音符是装饰，不参与判定，连击也不计
        if (note.isFake) continue;
        const jn: JudgeNote = {
          note,
          lineIndex,
          hitSeconds: chart.time.secondsAt(note.startBeats),
          endSeconds: chart.time.secondsAt(note.endBeats),
          resolved: false,
          grade: Grade.Miss,
          resolvedAt: 0,
          holding: false,
          broken: false,
          lastHeldAt: 0,
        };
        this.notes.push(jn);
        this.byNote.set(note, jn);
      }
    }

    this.notes.sort((a, b) => a.hitSeconds - b.hitSeconds);
    this.total = this.notes.length;
    this.reset();
  }

  reset(): void {
    for (const jn of this.notes) {
      jn.resolved = false;
      jn.holding = false;
      jn.broken = false;
      jn.grade = Grade.Miss;
      jn.resolvedAt = 0;
      jn.lastHeldAt = 0;
    }
    this.holding.clear();
    this.cursor = 0;
    this.perfect = 0;
    this.good = 0;
    this.miss = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.lastGrade = null;
    this.lastGradeAt = 0;
  }

  /** 渲染层用这个查音符当前状态；返回 undefined 表示这个音符不参与判定 */
  runtimeOf(note: Note): NoteRuntime | undefined {
    return this.byNote.get(note);
  }

  get stats(): SessionStats {
    const judged = this.perfect + this.good + this.miss;
    const accSum =
      this.perfect * GRADE_ACCURACY[Grade.Perfect] + this.good * GRADE_ACCURACY[Grade.Good];
    const accuracy = judged > 0 ? accSum / judged : 1;
    const score =
      this.total > 0
        ? Math.round(
            900000 * (accSum / this.total) + 100000 * (this.maxCombo / this.total),
          )
        : 0;
    return {
      perfect: this.perfect,
      good: this.good,
      miss: this.miss,
      combo: this.combo,
      maxCombo: this.maxCombo,
      judged,
      total: this.total,
      score,
      accuracy,
      rank: rankOf(score),
    };
  }

  // —————————————— 判定 ——————————————

  private applyGrade(jn: JudgeNote, grade: Grade, seconds: number): void {
    jn.resolved = true;
    jn.grade = grade;
    jn.resolvedAt = seconds;
    this.lastGrade = grade;
    this.lastGradeAt = seconds;

    if (grade === Grade.Miss) {
      this.miss++;
      this.combo = 0;
      return;
    }

    if (grade === Grade.Perfect) this.perfect++;
    else this.good++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
  }

  /**
   * 处理一个输入事件。返回被判定到的音符，没命中返回 null。
   */
  handleInput(input: TapInput): JudgeNote | null {
    const allowTypes: NoteType[] =
      input.kind === 'flick'
        ? [NoteType.Flick]
        : JUDGMENT.flickRequiresGesture
          ? [NoteType.Tap, NoteType.Hold]
          : [NoteType.Tap, NoteType.Hold, NoteType.Flick];

    let best: JudgeNote | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (let i = this.cursor; i < this.notes.length; i++) {
      const jn = this.notes[i];
      const diff = jn.hitSeconds - input.seconds;
      if (diff > JUDGMENT.good) break;
      if (jn.resolved || jn.broken) continue;
      if (!allowTypes.includes(jn.note.type)) continue;
      const abs = Math.abs(diff);
      if (abs > JUDGMENT.good || abs >= bestDiff) continue;
      best = jn;
      bestDiff = abs;
    }

    if (!best) return null;

    const grade = bestDiff <= JUDGMENT.perfect ? Grade.Perfect : Grade.Good;
    const wasHolding = best.holding;
    if (!wasHolding) this.applyGrade(best, grade, input.seconds);

    if (best.note.type === NoteType.Hold) {
      best.holding = true;
      best.lastHeldAt = input.seconds;
      this.holding.add(best);
    }
    return best;
  }

  /**
   * 推进到 seconds 时刻。`pointersDown` 是当前屏幕上的手指数，
   * Drag 音符和长按都依赖它。
   */
  update(seconds: number, pointersDown: number): void {
    const notes = this.notes;

    // 该判的都判掉：窗口内没被点到的直接 Miss；Drag 有手指就算过
    for (let i = this.cursor; i < notes.length; i++) {
      const jn = notes[i];
      if (jn.hitSeconds - JUDGMENT.good > seconds) break;
      if (jn.resolved || jn.holding) continue;

      if (jn.note.type === NoteType.Drag && pointersDown > 0) {
        this.applyGrade(jn, Grade.Perfect, seconds);
        continue;
      }
      if (seconds > jn.hitSeconds + JUDGMENT.good) {
        this.applyGrade(jn, Grade.Miss, seconds);
      }
    }

    // 长按跟踪：按到底就收尾，松手超时就断开
    for (const jn of this.holding) {
      if (seconds >= jn.endSeconds) {
        jn.holding = false;
        this.holding.delete(jn);
        continue;
      }
      if (pointersDown > 0) {
        jn.lastHeldAt = seconds;
      } else if (seconds - jn.lastHeldAt > JUDGMENT.holdGrace) {
        this.breakHold(jn, seconds);
      }
    }
  }

  /**
   * 长按中途松手。头部的评级要撤回 —— 否则同一个音符会同时算一次 Perfect 和一次 Miss。
   */
  private breakHold(jn: JudgeNote, seconds: number): void {
    if (jn.grade === Grade.Perfect) this.perfect--;
    else if (jn.grade === Grade.Good) this.good--;
    this.miss++;
    this.combo = 0;
    jn.grade = Grade.Miss;
    jn.broken = true;
    jn.resolvedAt = seconds;
    jn.holding = false;
    this.holding.delete(jn);
    this.lastGrade = Grade.Miss;
    this.lastGradeAt = seconds;
  }

  /** 供渲染层遍历用（已按命中时间排序） */
  get judgeNotes(): readonly JudgeNote[] {
    return this.notes;
  }
}
