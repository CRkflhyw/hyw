import { JUDGMENT } from './judgment';

/**
 * 输入采集。
 *
 * Phigros 是纯点按游戏：**没有位置判定**，手指点在哪里都算，
 * 所以这里只关心两件事：什么时候按下、以及按下之后有没有滑动。
 * 坐标只在打开 `JUDGMENT.checkPosition` 时才会用到。
 */

export interface TapInput {
  /** 事件发生时的歌曲时间，秒 */
  seconds: number;
  kind: 'down' | 'flick';
  x: number;
  y: number;
}

/** 桌面端用来代替手指的按键 */
const TAP_KEYS = new Set(['KeyD', 'KeyF', 'KeyJ', 'KeyK']);

export class InputTracker {
  private readonly queue: TapInput[] = [];
  /** pointerId -> 按下时的位置，用来判断滑动 */
  private readonly pointers = new Map<number, { x: number; y: number; flicked: boolean }>();

  private keyDown = 0;
  private disposed = false;

  /** 累计收到的输入事件数。用于调试和自动化验证「事件真的接上了」。 */
  received = 0;

  constructor(
    private readonly target: HTMLElement,
    /** 读取当前歌曲时间 */
    private readonly now: () => number,
  ) {
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointercancel', this.onPointerUp);
    target.addEventListener('pointerleave', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // 拖拽选择会打断输入
    target.addEventListener('dragstart', (event) => event.preventDefault());
    target.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /** 当前有几个指针按在屏幕上（长按和 Drag 音符都靠它） */
  get pointersDown(): number {
    return this.pointers.size + (this.keyDown > 0 ? 1 : 0);
  }

  /** 取走这一帧积累的输入事件 */
  poll(): TapInput[] {
    if (this.queue.length === 0) return [];
    const out = this.queue.slice();
    this.queue.length = 0;
    return out;
  }

  reset(): void {
    this.queue.length = 0;
    this.pointers.clear();
    this.keyDown = 0;
    this.received = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointercancel', this.onPointerUp);
    this.target.removeEventListener('pointerleave', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    try {
      this.target.setPointerCapture(event.pointerId);
    } catch {
      // 合成出来的指针事件没有真实指针，捕获会失败；不影响判定
    }
    this.received++;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, flicked: false });
    // 时间戳在事件处理里立刻读，晚读会让判定整体偏晚
    this.queue.push({
      seconds: this.now(),
      kind: 'down',
      x: event.clientX,
      y: event.clientY,
    });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer || pointer.flicked) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (dx * dx + dy * dy < JUDGMENT.flickDistance * JUDGMENT.flickDistance) return;

    pointer.flicked = true;
    this.received++;
    this.queue.push({
      seconds: this.now(),
      kind: 'flick',
      x: event.clientX,
      y: event.clientY,
    });
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || !TAP_KEYS.has(event.code)) return;
    this.keyDown++;
    this.received++;
    // 键盘没有落点，放在屏幕中心
    this.queue.push({
      seconds: this.now(),
      kind: 'down',
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!TAP_KEYS.has(event.code)) return;
    this.keyDown = Math.max(0, this.keyDown - 1);
  };
}
