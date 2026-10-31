/**
 * 基于 Web Audio 的歌曲时钟。
 *
 * 音游的时钟必须是音频时钟，不能用 performance.now() 或 rAF 的时间戳 ——
 * 后者和实际播放位置会持续漂移，判定就会时早时晚。
 *
 * 另外「你听到的时刻」比音频上下文的处理时刻要晚 outputLatency 秒，
 * 所以画面要按扣掉这段延迟之后的位置来画，否则会整体偏早。
 */
export class SongClock {
  private readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  /** 本次播放从歌曲的第几秒开始 */
  private startOffset = 0;
  /** 调用 start() 时音频上下文的时刻 */
  private startCtxTime = 0;

  /** 暂停时停在的位置，秒 */
  private pausedAt = 0;
  private playing = false;

  /**
   * 用户校准偏移，秒。
   * 数值越大，谱面相对音乐越晚（音符看起来来得越晚）。
   */
  offset = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get context(): AudioContext {
    return this.ctx;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async decode(data: ArrayBuffer): Promise<void> {
    this.stop();
    // decodeAudioData 会「吃掉」传入的 buffer，谱面包里的字节要留着复用所以先复制
    this.buffer = await this.ctx.decodeAudioData(data.slice(0));
    this.pausedAt = 0;
  }

  /** 音频上下文可能因为浏览器策略处于挂起状态，第一次交互时要唤醒 */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  play(fromSeconds = this.pausedAt): void {
    if (!this.buffer) return;
    this.stopSource();

    const offset = Math.max(0, Math.min(fromSeconds, this.buffer.duration));
    this.startOffset = offset;
    this.startCtxTime = this.ctx.currentTime;
    this.pausedAt = offset;

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.ctx.destination);
    source.start(0, offset);
    this.source = source;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.seconds;
    this.stopSource();
    this.playing = false;
  }

  seek(seconds: number): void {
    const wasPlaying = this.playing;
    const target = Math.max(0, Math.min(seconds, this.duration));
    this.stopSource();
    this.pausedAt = target;
    this.playing = false;
    if (wasPlaying) this.play(target);
  }

  stop(): void {
    this.stopSource();
    this.playing = false;
    this.pausedAt = 0;
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // 已经停过就忽略
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** 歌曲当前的播放位置，秒 */
  get seconds(): number {
    if (!this.playing) return this.pausedAt;

    // 输出延迟：从音频被处理到实际发出声音之间的时间
    const latency = this.ctx.outputLatency ?? 0;
    const heard = this.startOffset + (this.ctx.currentTime - latency - this.startCtxTime);
    return heard - this.offset;
  }
}
