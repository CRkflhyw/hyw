import { Container, Graphics, Sprite, Texture, type Application } from 'pixi.js';
import { trackValueAt } from '../chart/parse';
import { NoteType, type Chart, type JudgeLine } from '../chart/types';
import { Grade } from '../game/judgment';
import type { PlaySession } from '../game/session';

/**
 * RPE 坐标里 playfield 的高度固定是 900（y 从 -450 到 450），渲染时按画布高度铺满。
 * 横坐标用同一个比例，所以宽屏会看到比设计稿更宽的范围，和 Phigros 的行为一致。
 */
const PLAYFIELD_HEIGHT = 900;

/** 音符在 RPE 坐标下的基准尺寸 */
const NOTE_WIDTH = 170;
const NOTE_HEIGHT = 34;
const DRAG_HEIGHT = 26;
/** 判定线在 RPE 坐标下的粗细 */
const LINE_THICKNESS = 7;

/** 打击特效持续时长，秒 */
const HIT_EFFECT_SECONDS = 0.28;

const COLOR_TAP = 0x8ac6ff;
const COLOR_DRAG = 0xffd166;
const COLOR_FLICK = 0xff8fb1;
const COLOR_HOLD = 0x8ac6ff;

const GRADE_COLOR: Record<Grade, number> = {
  [Grade.Perfect]: 0x9be7ff,
  [Grade.Good]: 0xffd166,
  [Grade.Miss]: 0xff6b6b,
};

interface LineTransform {
  x: number;
  y: number;
  /** 弧度，RPE 坐标系（y 轴向上） */
  theta: number;
  /** 0~1 */
  alpha: number;
}

function makeNoteTexture(app: Application, width: number, height: number, color: number): Texture {
  const g = new Graphics();
  // 主体 + 顶部亮边，做出一点立体感
  g.roundRect(-width / 2, -height / 2, width, height, height * 0.32).fill(color);
  g.roundRect(-width / 2, -height / 2, width, height * 0.28, height * 0.14).fill({
    color: 0xffffff,
    alpha: 0.35,
  });
  const tex = app.renderer.generateTexture({ target: g, resolution: 2 });
  g.destroy();
  return tex;
}

function makeBarTexture(app: Application, color: number, layers = 1): Texture {
  const g = new Graphics();
  const h = LINE_THICKNESS;
  if (layers === 1) {
    g.rect(-32, -h / 2, 64, h).fill(color);
  } else {
    // 上下渐变，让判定线边缘柔和一些
    g.rect(-32, -h / 2, 64, h).fill({ color, alpha: 0.22 });
    g.rect(-32, -h * 0.3, 64, h * 0.6).fill({ color, alpha: 0.6 });
    g.rect(-32, -h * 0.14, 64, h * 0.28).fill({ color, alpha: 1 });
  }
  const tex = app.renderer.generateTexture({ target: g, resolution: 2 });
  g.destroy();
  return tex;
}

function makeRingTexture(app: Application): Texture {
  const g = new Graphics();
  g.circle(0, 0, 30).stroke({ width: 5, color: 0xffffff, alpha: 1 });
  const tex = app.renderer.generateTexture({ target: g, resolution: 2 });
  g.destroy();
  return tex;
}

/** 简单的精灵池，避免每帧创建销毁对象 */
class SpritePool {
  private sprites: Sprite[] = [];
  private used = 0;

  constructor(
    private readonly container: Container,
    private readonly texture: Texture,
  ) {}

  begin(): void {
    this.used = 0;
  }

  next(): Sprite {
    let sprite = this.sprites[this.used];
    if (!sprite) {
      sprite = new Sprite(this.texture);
      sprite.anchor.set(0.5);
      this.container.addChild(sprite);
      this.sprites.push(sprite);
    }
    this.used++;
    sprite.visible = true;
    return sprite;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}

export class ChartRenderer {
  private readonly belowLines: SpritePool;
  private readonly coverLines: SpritePool;
  private readonly taps: SpritePool;
  private readonly drags: SpritePool;
  private readonly flicks: SpritePool;
  private readonly holdHeads: SpritePool;
  private readonly holdBodies: SpritePool;
  private readonly effects: SpritePool;

  private readonly lineTex: Texture;

  /** 按 zOrder 排好的绘制顺序 */
  private drawOrder: number[] = [];
  private coverSet = new Set<number>();

  /**
   * 最近一帧的画面上有什么。
   * 用于调试和自动化验证 —— 标签页不可见时截图不可靠，但这份统计始终可得。
   */
  readonly lastFrame = {
    beats: 0,
    linesDrawn: 0,
    notesDrawn: 0,
    holdsDrawn: 0,
    effectsDrawn: 0,
    byType: { tap: 0, hold: 0, flick: 0, drag: 0 },
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };

  constructor(private readonly app: Application) {
    const root = new Container();
    app.stage.addChild(root);

    const belowLayer = new Container();
    const noteLayer = new Container();
    const coverLayer = new Container();
    root.addChild(belowLayer, noteLayer, coverLayer);

    this.lineTex = makeBarTexture(app, 0xffffff, 3);

    this.belowLines = new SpritePool(belowLayer, this.lineTex);
    this.coverLines = new SpritePool(coverLayer, this.lineTex);
    this.taps = new SpritePool(noteLayer, makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_TAP));
    this.drags = new SpritePool(
      noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, DRAG_HEIGHT, COLOR_DRAG),
    );
    this.flicks = new SpritePool(
      noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_FLICK),
    );
    this.holdHeads = new SpritePool(
      noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_HOLD),
    );
    this.holdBodies = new SpritePool(noteLayer, makeBarTexture(app, COLOR_HOLD));
    this.effects = new SpritePool(noteLayer, makeRingTexture(app));
  }

  setChart(chart: Chart): void {
    this.drawOrder = chart.lines
      .map((l, i) => ({ i, z: l.zOrder }))
      .sort((a, b) => a.z - b.z)
      .map((e) => e.i);
    this.coverSet = new Set(
      chart.lines.map((l, i) => (l.isCover ? i : -1)).filter((i) => i >= 0),
    );
  }

  /**
   * 解析判定线的世界变换，顺带处理父级链。
   *
   * RPE 的 `father` 是层级变换：子线的位移要按父线的旋转摆到父线坐标系里，
   * 旋转也要累加。谱面里用得很普遍（一个参考谱面 282 条线里有 160 条带父级）。
   */
  private resolveTransforms(chart: Chart, beats: number): LineTransform[] {
    const out: (LineTransform | undefined)[] = new Array(chart.lines.length);
    const visiting = new Uint8Array(chart.lines.length);

    const compute = (index: number): LineTransform => {
      const cached = out[index];
      if (cached) return cached;

      const line: JudgeLine = chart.lines[index];
      const local: LineTransform = {
        x: trackValueAt(line.moveX, beats),
        y: trackValueAt(line.moveY, beats),
        // 谱面里存的是角度，渲染用弧度
        theta: (trackValueAt(line.rotate, beats) * Math.PI) / 180,
        alpha: trackValueAt(line.alpha, beats) / 255,
      };

      let result = local;
      const father = line.father;
      if (father >= 0 && father < chart.lines.length && father !== index && !visiting[father]) {
        visiting[index] = 1;
        const parent = compute(father);
        visiting[index] = 0;
        const cos = Math.cos(parent.theta);
        const sin = Math.sin(parent.theta);
        result = {
          x: parent.x + local.x * cos - local.y * sin,
          y: parent.y + local.x * sin + local.y * cos,
          theta: parent.theta + local.theta,
          // alpha 不沿父级相乘：它是每条线自己的属性
          alpha: local.alpha,
        };
      }

      out[index] = result;
      return result;
    };

    const result: LineTransform[] = new Array(chart.lines.length);
    for (let i = 0; i < chart.lines.length; i++) result[i] = compute(i);
    return result;
  }

  /**
   * 把谱面渲染到 `seconds` 时刻的状态。
   * 传入 `session` 后会按判定状态决定音符画不画、并播打击特效。
   */
  render(chart: Chart, seconds: number, session?: PlaySession): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const scale = height / PLAYFIELD_HEIGHT;
    const centerX = width / 2;
    const centerY = height / 2;

    const beats = chart.time.beatsAt(seconds);
    const transforms = this.resolveTransforms(chart, beats);
    const lineFloors = chart.lines.map((line) => line.speed.floorAt(beats));

    this.belowLines.begin();
    this.coverLines.begin();
    this.taps.begin();
    this.drags.begin();
    this.flicks.begin();
    this.holdHeads.begin();
    this.holdBodies.begin();
    this.effects.begin();

    const stats = this.lastFrame;
    stats.beats = beats;
    stats.linesDrawn = 0;
    stats.notesDrawn = 0;
    stats.holdsDrawn = 0;
    stats.effectsDrawn = 0;
    stats.byType = { tap: 0, hold: 0, flick: 0, drag: 0 };
    stats.bounds = {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };

    // 屏幕外多留一些余量，避免边缘音符突然消失
    const marginX = width * 0.5;
    const marginY = height * 0.5;
    const lineHalfWidth = (width / scale) * 0.75;
    const lineWidthPx = lineHalfWidth * 2 * scale;

    for (const index of this.drawOrder) {
      const line = chart.lines[index];
      const t = transforms[index];
      if (t.alpha <= 0.002) continue;

      const cos = Math.cos(t.theta);
      const sin = Math.sin(t.theta);
      const lineX = centerX + t.x * scale;
      const lineY = centerY - t.y * scale;

      // 判定线本身
      if (lineX > -marginX - lineWidthPx && lineX < width + marginX + lineWidthPx) {
        const pool = this.coverSet.has(index) ? this.coverLines : this.belowLines;
        const sprite = pool.next();
        sprite.position.set(lineX, lineY);
        sprite.rotation = -t.theta;
        sprite.width = lineWidthPx;
        sprite.height = LINE_THICKNESS * scale;
        sprite.alpha = t.alpha;
        stats.linesDrawn++;
      }

      const lineFloor = lineFloors[index];
      const a = 0.008; // 跳过几乎不可见的音符

      const project = (lx: number, ly: number): [number, number] => [
        centerX + (t.x + lx * cos - ly * sin) * scale,
        centerY - (t.y + lx * sin + ly * cos) * scale,
      ];

      for (const note of line.notes) {
        if (note.alpha <= a) continue;

        const runtime = session?.runtimeOf(note);
        const isHold = note.type === NoteType.Hold;
        const dir = note.above ? 1 : -1;
        const localX = note.positionX;

        // 音符相对判定线的偏移：floor 差 × 音符自身速度 + yOffset
        const offsetFor = (noteBeats: number) =>
          (line.speed.floorAt(noteBeats) - lineFloor) * note.speed + note.yOffset;

        // 已经判定过：音符本身不再画，只在刚判定的一瞬间播个特效
        if (runtime?.resolved && !runtime.holding) {
          const age = seconds - runtime.resolvedAt;
          if (age >= 0 && age < HIT_EFFECT_SECONDS) {
            const [ex, ey] = project(localX, dir * note.yOffset);
            if (ex > -marginX && ex < width + marginX && ey > -marginY && ey < height + marginY) {
              const effect = this.effects.next();
              const progress = age / HIT_EFFECT_SECONDS;
              effect.position.set(ex, ey);
              effect.rotation = -t.theta;
              effect.scale.set((0.55 + progress * 0.9) * scale);
              effect.alpha = (1 - progress) * 0.85;
              effect.tint = GRADE_COLOR[runtime.grade];
              stats.effectsDrawn++;
            }
          }
          continue;
        }

        // visibleBeats 为 Infinity 表示全程可见，不能直接拿来比较
        if (Number.isFinite(note.visibleBeats) && beats < note.visibleBeats) continue;
        // 已经越过线就收起（长按持续到结束）
        if (beats > note.endBeats) continue;

        // 头部到达后钉在判定线上，尾部继续靠近 —— 长按条因此会逐帧缩短
        const headOffset = beats >= note.startBeats ? note.yOffset : offsetFor(note.startBeats);
        const tailOffset = isHold
          ? beats >= note.endBeats
            ? note.yOffset
            : offsetFor(note.endBeats)
          : headOffset;

        const noteWidth = NOTE_WIDTH * note.size;
        const noteHeightPx = (note.type === NoteType.Drag ? DRAG_HEIGHT : NOTE_HEIGHT) * scale;

        const [sx, sy] = project(localX, dir * headOffset);
        if (sx < -marginX || sx > width + marginX || sy < -marginY || sy > height + marginY) {
          continue;
        }

        // 长按条本体
        if (isHold && Math.abs(tailOffset - headOffset) > 0.5) {
          const [tx, ty] = project(localX, dir * tailOffset);
          const body = this.holdBodies.next();
          body.position.set((sx + tx) / 2, (sy + ty) / 2);
          body.rotation = -t.theta;
          body.width = noteWidth * scale;
          body.height = Math.hypot(sx - tx, sy - ty);
          body.alpha = note.alpha * t.alpha * 0.55;
        }

        const pool =
          note.type === NoteType.Hold
            ? this.holdHeads
            : note.type === NoteType.Drag
              ? this.drags
              : note.type === NoteType.Flick
                ? this.flicks
                : this.taps;

        const sprite = pool.next();
        sprite.position.set(sx, sy);
        sprite.rotation = -t.theta;
        sprite.width = noteWidth * scale;
        sprite.height = noteHeightPx;
        sprite.alpha = note.alpha * t.alpha;
        // 假音符（装饰用、不参与判定）压低透明度以便区分
        if (note.isFake) sprite.alpha *= 0.55;

        stats.notesDrawn++;
        if (isHold) stats.holdsDrawn++;
        stats.bounds.minX = Math.min(stats.bounds.minX, sx);
        stats.bounds.maxX = Math.max(stats.bounds.maxX, sx);
        stats.bounds.minY = Math.min(stats.bounds.minY, sy);
        stats.bounds.maxY = Math.max(stats.bounds.maxY, sy);
        if (note.type === NoteType.Hold) stats.byType.hold++;
        else if (note.type === NoteType.Drag) stats.byType.drag++;
        else if (note.type === NoteType.Flick) stats.byType.flick++;
        else stats.byType.tap++;
      }
    }

    this.belowLines.end();
    this.coverLines.end();
    this.taps.end();
    this.drags.end();
    this.flicks.end();
    this.holdHeads.end();
    this.holdBodies.end();
    this.effects.end();
  }
}
