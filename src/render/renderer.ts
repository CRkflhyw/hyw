import { Container, Graphics, Sprite, Text, Texture, type Application } from 'pixi.js';
import { textAt, textEventAt, trackValueAt } from '../chart/parse';
import type { LineTextures } from '../chart/textures';
import { DEFAULT_LINE_UNITS } from '../chart/textures';
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

/** 判定线上的文字：世界坐标下的字号（playfield 高 900），以及 Pixi 文字对象用的基准字号 */
const TEXT_FONT_UNITS = 56;
const TEXT_BASE_FONT_PX = 64;
/** 谱面里写的字体基本都没装，后面这串是兜底 */
const TEXT_FONT_FALLBACK = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
/** 文字跟着判定线的扩展缩放走，但别让离谱的值把画布撑爆 */
const TEXT_MAX_SCALE = 20;
const TEXT_STYLE = {
  fontFamily: TEXT_FONT_FALLBACK,
  fontSize: TEXT_BASE_FONT_PX,
  fill: 0xffffff,
};

/** 兜底判定线（真实 line.png 是游戏内置资源，谱面包里通常没有） */
const LINE_THICKNESS = DEFAULT_LINE_UNITS[1];

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
  private readonly belowLayer = new Container();
  private readonly textLayer = new Container();
  private readonly noteLayer = new Container();
  private readonly coverLayer = new Container();

  private readonly taps: SpritePool;
  private readonly drags: SpritePool;
  private readonly flicks: SpritePool;
  private readonly holdHeads: SpritePool;
  private readonly holdBodies: SpritePool;
  private readonly effects: SpritePool;

  private readonly fallbackLineTex: Texture;

  /** 每条判定线一个精灵 —— 贴图各不相同，用对象池不划算 */
  private lineSprites: (Sprite | null)[] = [];
  /** 每条线的贴图自然尺寸（RPE 单位） */
  private lineUnits: [number, number][] = [];
  private lineTextureNames: string[] = [];
  /** 带文字事件的线只画文字，不画判定线本体 */
  private isTextLine: boolean[] = [];
  private textObjects: (Text | null)[] = [];
  /** 已经设给文字对象的字体，避免每帧都让 Pixi 重画贴图 */
  private textFonts: string[] = [];
  /** 最近一帧每条线算出来的扩展缩放，调试用 */
  private lineScale: [number, number][] = [];
  /** 最近一帧每条线的当前不透明度（sprite.alpha 被隐藏时会停在旧值，这里存真值） */
  private lineAlpha: number[] = [];

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
    texturedLines: 0,
    textsDrawn: 0,
    notesDrawn: 0,
    holdsDrawn: 0,
    effectsDrawn: 0,
    byType: { tap: 0, hold: 0, flick: 0, drag: 0 },
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };

  constructor(private readonly app: Application) {
    app.stage.addChild(this.belowLayer, this.textLayer, this.noteLayer, this.coverLayer);

    this.fallbackLineTex = makeBarTexture(app, 0xffffff, 3);

    this.taps = new SpritePool(this.noteLayer, makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_TAP));
    this.drags = new SpritePool(
      this.noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, DRAG_HEIGHT, COLOR_DRAG),
    );
    this.flicks = new SpritePool(
      this.noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_FLICK),
    );
    this.holdHeads = new SpritePool(
      this.noteLayer,
      makeNoteTexture(app, NOTE_WIDTH, NOTE_HEIGHT, COLOR_HOLD),
    );
    this.holdBodies = new SpritePool(this.noteLayer, makeBarTexture(app, COLOR_HOLD));
    this.effects = new SpritePool(this.noteLayer, makeRingTexture(app));
  }

  setChart(chart: Chart, textures: LineTextures): void {
    this.belowLayer.removeChildren();
    this.coverLayer.removeChildren();
    this.textLayer.removeChildren();

    this.drawOrder = chart.lines
      .map((l, i) => ({ i, z: l.zOrder }))
      .sort((a, b) => a.z - b.z)
      .map((e) => e.i);
    this.coverSet = new Set(
      chart.lines.map((l, i) => (l.isCover ? i : -1)).filter((i) => i >= 0),
    );

    this.lineUnits = textures.unitsByLine;
    this.lineTextureNames = chart.lines.map((l) => l.textureName);
    this.isTextLine = chart.lines.map((l) => l.text.events.length > 0);
    this.lineSprites = [];
    this.textObjects = [];
    this.textFonts = [];
    this.lineScale = [];
    this.lineAlpha = [];

    for (const [index, line] of chart.lines.entries()) {
      /*
       * 带文字事件的线在 RPE 里只显示文字 —— 它自己的贴图（哪怕填了图）根本不画。
       * 两个独立实现都是这么处理的（kipphi-player 的 hasText 分支、
       * phi-chart-render 的 isText 分支），照着来。
       */
      if (this.isTextLine[index]) {
        this.lineSprites.push(null);
        continue;
      }
      const texture = textures.map.get(line.textureName) ?? this.fallbackLineTex;
      const sprite = new Sprite(texture);
      // anchor 是判定线的旋转/缩放原点，RPE 谱面里几乎都是 [0.5, 0.5]
      sprite.anchor.set(line.anchor[0], line.anchor[1]);
      sprite.visible = false;
      this.lineSprites.push(sprite);
    }

    // 按 zOrder 把精灵挂进对应图层（isCover 的线要盖在音符上面）
    for (const index of this.drawOrder) {
      const sprite = this.lineSprites[index];
      if (!sprite) continue;
      (this.coverSet.has(index) ? this.coverLayer : this.belowLayer).addChild(sprite);
    }
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
   * 某条判定线当前的计算结果。用于调试渲染问题（比如贴图尺寸算得对不对），
   * 也方便自动化验证 —— 标签页不可见时截图不可靠。
   */
  describeLine(index: number): Record<string, unknown> | null {
    if (index < 0 || index >= this.lineTextureNames.length) return null;
    const sprite = this.lineSprites[index];
    const text = this.textObjects[index];
    const units = this.lineUnits[index] ?? DEFAULT_LINE_UNITS;
    const [scaleX, scaleY] = this.lineScale[index] ?? [null, null];
    return {
      texture: this.lineTextureNames[index],
      isTextLine: this.isTextLine[index],
      naturalUnits: [units[0], units[1]],
      // 谱面里写的就是这两个值：1 = 贴图自然大小，负数是镜像
      scaleX,
      scaleY,
      // 只有真的画出来了，屏幕尺寸才有意义（隐藏时精灵里是上一帧的旧值）
      screenWidth: sprite?.visible ? Math.round(sprite.width) : null,
      screenHeight: sprite?.visible ? Math.round(sprite.height) : null,
      x: Math.round((sprite ?? text)?.position.x ?? 0),
      y: Math.round((sprite ?? text)?.position.y ?? 0),
      rotationDeg: Math.round((((sprite ?? text)?.rotation ?? 0) * 180) / Math.PI),
      alpha: Number((this.lineAlpha[index] ?? 0).toFixed(3)),
      visible: sprite ? sprite.visible : text ? text.visible : false,
      text: text?.visible ? text.text : null,
      textFont: this.textFonts[index] ?? null,
      textFontUnits: TEXT_FONT_UNITS,
    };
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

    this.taps.begin();
    this.drags.begin();
    this.flicks.begin();
    this.holdHeads.begin();
    this.holdBodies.begin();
    this.effects.begin();

    const stats = this.lastFrame;
    stats.beats = beats;
    stats.linesDrawn = 0;
    stats.texturedLines = 0;
    stats.textsDrawn = 0;
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
    /** 位置离谱到这个程度就直接不画，免得出现天文数字的坐标 */
    const crazyLimit = width * 40;

    for (const index of this.drawOrder) {
      const line = chart.lines[index];
      const t = transforms[index];
      const sprite = this.lineSprites[index];

      // 判定线的拉伸/缩放完全由扩展的 scaleX/scaleY 决定（1 = 贴图自然大小）
      const scaleXValue = trackValueAt(line.scaleX, beats);
      const scaleYValue = trackValueAt(line.scaleY, beats);
      // 调试信息每帧都记，被隐藏的线也要能查到当前值
      this.lineScale[index] = [scaleXValue, scaleYValue];
      this.lineAlpha[index] = t.alpha;

      if (t.alpha <= 0.002) {
        if (sprite) sprite.visible = false;
        const text = this.textObjects[index];
        if (text) text.visible = false;
        continue;
      }

      const cos = Math.cos(t.theta);
      const sin = Math.sin(t.theta);
      const lineX = centerX + t.x * scale;
      const lineY = centerY - t.y * scale;
      const tint =
        (((trackValueAt(line.colorR, beats) & 0xff) << 16) |
          ((trackValueAt(line.colorG, beats) & 0xff) << 8) |
          (trackValueAt(line.colorB, beats) & 0xff)) >>>
        0;

      // 判定线本体：贴图的自然尺寸 × 扩展事件的缩放 + 染色
      if (sprite) {
        const units = this.lineUnits[index] ?? [DEFAULT_LINE_UNITS[0], DEFAULT_LINE_UNITS[1]];
        let sizeX = units[0] * scaleXValue * scale;
        let sizeY = units[1] * scaleYValue * scale;

        /*
         * 有些谱面会写极端的缩放值（见过 scaleX=100、scaleY=200，算出来 40 万单位宽），
         * 那是拿判定线当「铺满屏幕的色块」用。上限只是为了别让包围盒变成天文数字，
         * 但**必须按轴各自压**：等比压会把细长条压成一根细棍，看起来就像「拉伸没生效」。
         */
        const maxSide = Math.hypot(width, height) * 3;
        sizeX = Math.max(-maxSide, Math.min(maxSide, sizeX));
        sizeY = Math.max(-maxSide, Math.min(maxSide, sizeY));

        // 负的缩放值在 RPE 里是「绕 anchor 镜像」，这里把符号一起交给精灵
        if (
          Math.abs(lineX) > crazyLimit ||
          Math.abs(lineY) > crazyLimit ||
          Math.abs(sizeX) < 0.5 ||
          Math.abs(sizeY) < 0.5
        ) {
          sprite.visible = false;
        } else {
          sprite.visible = true;
          sprite.position.set(lineX, lineY);
          sprite.rotation = -t.theta;
          sprite.scale.set(sizeX / sprite.texture.width, sizeY / sprite.texture.height);
          sprite.alpha = t.alpha;
          sprite.tint = tint;
          if (line.textureName !== 'line.png') stats.texturedLines++;
          stats.linesDrawn++;
        }
      }

      // 判定线上的文字（带文字事件的线只画这个）
      const textEvent = textEventAt(line.text, beats);
      const label = textAt(line.text, beats);
      let textObj = this.textObjects[index];
      if (!label) {
        if (textObj) textObj.visible = false;
      } else {
        if (!textObj) {
          textObj = new Text({ text: label, style: TEXT_STYLE });
          textObj.anchor.set(0.5);
          this.textLayer.addChild(textObj);
          this.textObjects[index] = textObj;
        } else if (textObj.text !== label) {
          textObj.text = label;
        }
        // 谱面里写的字体（cmdysj、Cambria Math…）多半没装，装了就用得上
        const family = textEvent?.font.replace(/["']/g, '').trim() ?? '';
        const fontFamily = family ? `"${family}", ${TEXT_FONT_FALLBACK}` : TEXT_FONT_FALLBACK;
        if (this.textFonts[index] !== fontFamily) {
          this.textFonts[index] = fontFamily;
          textObj.style.fontFamily = fontFamily;
        }
        const base = (TEXT_FONT_UNITS * scale) / TEXT_BASE_FONT_PX;
        const scaleX = Math.min(Math.abs(scaleXValue), TEXT_MAX_SCALE);
        const scaleY = Math.min(Math.abs(scaleYValue), TEXT_MAX_SCALE);
        textObj.visible = true;
        textObj.position.set(lineX, lineY);
        textObj.rotation = -t.theta;
        textObj.scale.set(base * scaleX, base * scaleY);
        textObj.alpha = t.alpha;
        textObj.tint = tint;
        stats.textsDrawn++;
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

        const noteSprite = pool.next();
        noteSprite.position.set(sx, sy);
        noteSprite.rotation = -t.theta;
        noteSprite.width = noteWidth * scale;
        noteSprite.height = noteHeightPx;
        noteSprite.alpha = note.alpha * t.alpha;
        // 假音符（装饰用、不参与判定）压低透明度以便区分
        if (note.isFake) noteSprite.alpha *= 0.55;

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

    this.taps.end();
    this.drags.end();
    this.flicks.end();
    this.holdHeads.end();
    this.holdBodies.end();
    this.effects.end();
  }
}
