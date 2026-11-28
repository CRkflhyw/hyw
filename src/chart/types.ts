/**
 * RPE（Re:PhiEdit）谱面格式的类型定义，以及播放时用的运行时结构。
 *
 * 格式要点（都是从真实谱面里实测出来的，不是猜的）：
 * - 时间是有理数三元组 `[整数拍, 分子, 分母]`，实际拍数 = a + b/c，用分数避免浮点累积误差
 * - `alpha` 是 0~255，不是 0~1
 * - `rotate` 事件是角度制
 * - 坐标单位是 RPE 坐标：Y 固定 ±450，X 是 ±450×宽高比
 * - 音符类型：1=Tap、2=Hold、3=Flick、4=Drag（**不是** Phigros 官方的编号顺序）
 *   —— 依据是只有 type 2 的音符会出现 endTime > startTime，即只有它是长按
 */

export type TimeT = [number, number, number];

/** 音符类型。2 是唯一有持续时间的类型，即长按。 */
export const enum NoteType {
  Tap = 1,
  Hold = 2,
  Flick = 3,
  Drag = 4,
}

// —————————————— 原始 JSON 结构 ——————————————

export interface BpmPointData {
  bpm: number;
  startTime: TimeT;
}

export interface EventData {
  startTime: TimeT;
  endTime: TimeT;
  start: number;
  end: number;
  easingType?: number;
  easingLeft?: number;
  easingRight?: number;
  bezier?: number;
  bezierPoints?: number[];
  linkgroup?: number;
}

export interface EventLayerData {
  alphaEvents?: EventData[];
  moveXEvents?: EventData[];
  moveYEvents?: EventData[];
  rotateEvents?: EventData[];
  speedEvents?: EventData[];
}

/** 颜色事件的 start/end 是 [r,g,b]（0~255）而不是数字 */
export interface ColorEventData {
  startTime: TimeT;
  endTime: TimeT;
  start: number[];
  end: number[];
  easingType?: number;
  easingLeft?: number;
  easingRight?: number;
}

/** 文字事件的 start/end 是字符串，另有 font 字段 */
export interface TextEventData {
  startTime: TimeT;
  endTime: TimeT;
  start: string;
  end: string;
  font?: string;
  easingType?: number;
  easingLeft?: number;
  easingRight?: number;
  bezier?: number;
  bezierPoints?: number[];
}

/**
 * RPE 的扩展事件层。
 *
 * 实测出来的单位（来自 Algebra 谱面，见下方注释）：
 * - scaleX / scaleY 是**直接倍数**（1 = 原始大小），不是百分比。
 *   依据：插画尺寸的贴图（1310×816px）用 1.15，正好略微铺满 1350×900 的设计画布。
 * - color 是相乘染色，[255,255,255] 表示不变（谱面里出现 572 次，是主流值）。
 * - incline 是倾斜角（这个谱面里恒为 0，暂未实现）。
 */
export interface ExtendedLayerData {
  scaleXEvents?: EventData[];
  scaleYEvents?: EventData[];
  colorEvents?: ColorEventData[];
  inclineEvents?: EventData[];
  textEvents?: TextEventData[];
}

export interface NoteData {
  type: number;
  startTime: TimeT;
  endTime: TimeT;
  positionX: number;
  yOffset: number;
  speed: number;
  size: number;
  /** 1 = 判定线上方；0 或 2 = 下方 */
  above: number;
  alpha: number;
  isFake: number;
  /** 打击前多少秒开始显现；>= 90000 视为一直可见 */
  visibleTime: number;
  /** PhiZone Player 扩展字段 */
  judgeSize?: number;
  judgeArea?: number;
}

export interface JudgeLineData {
  Group?: number;
  Name?: string;
  Texture?: string;
  anchor?: [number, number];
  bpmfactor?: number;
  /** 注意：这一层可能有 null 占位，真实谱面里确实出现过 */
  eventLayers?: (EventLayerData | null)[];
  extended?: ExtendedLayerData | null;
  father?: number;
  isCover?: number;
  isGif?: number;
  notes?: NoteData[];
  numOfNotes?: number;
  zOrder?: number;
  /**
   * 下面这些是 Phigros 官方格式的遗留字段。RPE 导出时会写入自动生成的默认值
   * （实测两个谱面里都恰好是每条判定线 2 条），播放时应以 eventLayers 为准。
   */
  alphaControl?: unknown[];
  posControl?: unknown[];
  sizeControl?: unknown[];
  skewControl?: unknown[];
  yControl?: unknown[];
}

export interface ChartMetaData {
  RPEVersion?: number;
  name?: string;
  level?: string;
  composer?: string;
  charter?: string;
  illustrator?: string;
  offset?: number;
  song?: string;
  background?: string;
  duration?: number;
  id?: string;
}

export interface ChartDataRPE {
  BPMList: BpmPointData[];
  META?: ChartMetaData;
  judgeLineGroup?: string[];
  judgeLineList: JudgeLineData[];
  multiLineString?: string;
  multiScale?: number;
  chartTime?: number;
}

// —————————————— 运行时结构 ——————————————

export interface BpmSegment {
  /** 该段起始拍 */
  beats: number;
  /** 该段起始拍对应的秒数 */
  seconds: number;
  bpm: number;
}

/** 拍数与秒数的双向换算 */
export interface TimeMap {
  segments: readonly BpmSegment[];
  secondsAt(beats: number): number;
  beatsAt(seconds: number): number;
}

/** 一条参数通道（moveX / moveY / rotate / alpha） */
export interface EventTrack {
  /** 按 startBeats 升序排列 */
  readonly events: readonly {
    startBeats: number;
    endBeats: number;
    start: number;
    end: number;
    ease: (t: number) => number;
  }[];
  readonly defaultValue: number;
}

/**
 * 判定线速度通道。判定线的速度决定了音符的移动速度，
 * 但渲染时真正需要的是它的积分 —— floor position。
 */
export interface SpeedTrack {
  /** floor position 是分段的二次函数，这里存每段的系数 */
  readonly segments: readonly {
    b0: number;
    b1: number;
    f0: number;
    s0: number;
    s1: number;
    /** 该段内每拍多少秒 */
    spb: number;
  }[];
  floorAt(beats: number): number;
}

export interface Note {
  type: NoteType;
  startBeats: number;
  endBeats: number;
  positionX: number;
  yOffset: number;
  /** 音符自身速度倍率 */
  speed: number;
  size: number;
  above: boolean;
  /** 0~1 */
  alpha: number;
  isFake: boolean;
  /** 从这个拍数开始可见；Infinity 表示全程可见 */
  visibleBeats: number;
}

/**
 * 一个文字事件。
 *
 * 它和别的通道不一样：`endBeats` 不决定文字什么时候消失 —— 文字会一直显示到
 * 同一条线的下一个文字事件出现为止，`endBeats` 只是「文字从 `text` 换成
 * `endText`」的时刻。谱面里绝大多数事件都写成 `start === end`（一段文字一段事件），
 * 于是看起来就像「一直挂着」。
 */
export interface TextKeyframe {
  startBeats: number;
  endBeats: number;
  /** startTime 之后显示的文字 */
  text: string;
  /** endTime 之后显示的文字；空字符串表示把文字清掉 */
  endText: string;
  /** start 为空而 end 非空：RPE 的「打字机」，随时间逐字显示 endText */
  typewriter: boolean;
  /** 谱面里写的字体名，通常装不上，用的时候要带兜底字体 */
  font: string;
  /** 打字机用的缓动 */
  ease: (t: number) => number;
}

/** 文字通道：在判定线上显示的文字，同一时刻最多一段 */
export interface TextTrack {
  readonly events: readonly TextKeyframe[];
}

export interface JudgeLine {
  id: number;
  name: string;
  zOrder: number;
  isCover: boolean;
  /** 父判定线下标，-1 表示没有父级 */
  father: number;
  anchor: [number, number];
  alpha: EventTrack;
  moveX: EventTrack;
  moveY: EventTrack;
  /** 弧度 */
  rotate: EventTrack;
  speed: SpeedTrack;
  /** 判定线贴图名，渲染时用它去贴图表里查 */
  textureName: string;
  /** 扩展事件 */
  scaleX: EventTrack;
  scaleY: EventTrack;
  /** 相乘染色，0~255，缺省 255（不变） */
  colorR: EventTrack;
  colorG: EventTrack;
  colorB: EventTrack;
  text: TextTrack;
  notes: Note[];
}

export interface Chart {
  meta: {
    name: string;
    level: string;
    composer: string;
    charter: string;
    illustrator: string;
    /** 谱面偏移，秒。正值表示谱面相对音频提前 */
    offset: number;
  };
  time: TimeMap;
  lines: JudgeLine[];
  /** 判定线 id -> 数组下标 */
  lineIndexById: Map<number, number>;
  maxCombo: number;
  /** 总的判定线数量（含无音符的装饰线） */
  totalNotes: number;
  totalBeats: number;
  durationSeconds: number;
}
