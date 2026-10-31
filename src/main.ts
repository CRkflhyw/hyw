import { Application } from 'pixi.js';
import { SongClock } from './audio/clock';
import { isPez, loadPez } from './chart/pez';
import { parseChart } from './chart/parse';
import type { Chart } from './chart/types';
import { InputTracker } from './game/input';
import { GRADE_LABEL, type Grade } from './game/judgment';
import { PlaySession } from './game/session';
import { ChartRenderer } from './render/renderer';
import { chartLibrary } from './ui/chartLibrary';
import './style.css';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

const app = new Application();
await app.init({
  background: '#0b0d12',
  resizeTo: window,
  antialias: true,
  autoDensity: true,
  resolution: window.devicePixelRatio,
});
$('stage').appendChild(app.canvas);

const renderer = new ChartRenderer(app);

// 音频上下文可以在没有用户交互时创建（会处于 suspended 状态），
// decodeAudioData 在挂起状态下也能正常工作，所以先把谱面解出来。
const clock = new SongClock(new AudioContext());

let chart: Chart | null = null;
let chartName = '';
let artUrl: string | null = null;

/** 观赏模式只按谱面播放，不判定；游玩模式才有判定和计分 */
let playMode = true;
let screen: 'home' | 'import' | 'play' = 'home';

const session = new PlaySession();

/** 当前谱面时间：歌曲时间扣掉谱面自己的 offset */
const chartSeconds = (): number => (chart ? clock.seconds - chart.meta.offset : 0);

// 输入挂到 canvas 上，点界面按钮就不会被当成音符输入
const input = new InputTracker(app.canvas, chartSeconds);

const OFFSET_KEY = 'hyw.offset';
clock.offset = Number(localStorage.getItem(OFFSET_KEY) ?? 0);

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = text === '';
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// —————————————— 画面切换 ——————————————

function showScreen(next: 'home' | 'import' | 'play'): void {
  screen = next;
  document.body.dataset.screen = next;
  // 离开游玩画面就暂停，免得在菜单上还在响
  if (next !== 'play' && clock.isPlaying) {
    clock.pause();
    $('play').textContent = '播放';
  }
  // 菜单上不需要渲染，停掉 ticker 省点 CPU
  if (next === 'play') app.ticker.start();
  else app.ticker.stop();
  updateHome();
}

function updateHome(): void {
  const resume = $('go-resume');
  const canResume = chart !== null;
  resume.hidden = !canResume;
  if (canResume) $('resume-note').textContent = chartName;
}

function updateChartInfo(): void {
  const hasChart = chart !== null;
  $('controls').hidden = !hasChart;
  $('info').hidden = !hasChart;
  $('hud').hidden = !hasChart || !playMode;
  $('mode').textContent = playMode ? '游玩中' : '观赏中';
  if (!chart) return;

  const beats = chart.time.beatsAt(chartSeconds());
  const bpm = chart.time.segments[0]?.bpm ?? 0;
  $('info').innerHTML = `
    <div class="title">${escapeHtml(chart.meta.name)}</div>
    <div class="sub">${escapeHtml(chart.meta.level)} · ${escapeHtml(chart.meta.charter)} · ${escapeHtml(chart.meta.composer)}</div>
    <div class="sub">${chart.lines.length} 条判定线 · ${chart.totalNotes} 音符 · 最大连击 ${chart.maxCombo} · ${bpm} BPM</div>
    <div class="sub dim">${escapeHtml(chartName)} · ${beats.toFixed(1)} 拍 · 偏移 ${(clock.offset * 1000).toFixed(0)}ms</div>
  `;
}

// —————————————— 谱面列表 ——————————————

function renderChartList(): void {
  const list = $('chart-list');
  list.innerHTML = '';
  if (chartLibrary.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = '谱面库是空的。把 .pez 文件复制进项目的 charts/ 目录，刷新页面就会出现在这里。';
    list.appendChild(empty);
    return;
  }

  for (const entry of chartLibrary) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chart-row';
    row.innerHTML = `<span class="name">${escapeHtml(entry.name)}</span><span class="meta">点击游玩</span>`;
    row.addEventListener('click', () => void openFromLibrary(entry.url, entry.name));
    list.appendChild(row);
  }
}

async function openFromLibrary(url: string, name: string): Promise<void> {
  // 用户激活（user activation）是有时限的，唤醒音频上下文要趁点击还热乎，
  // 别等 fetch + 解码走完再调，那时候可能已经过期了。
  void clock.resume();
  setStatus(`正在加载 ${name} …`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPezBuffer(await res.arrayBuffer(), `${name}.pez`);
    startPlaying();
  } catch (err) {
    setStatus(`加载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// —————————————— 加载谱面 ——————————————

/** 重开一局。任何倒着移动时间轴的操作都要调它，否则判定状态会乱。 */
function restartSession(): void {
  session.reset();
  input.reset();
  renderGameHud(true);
}

async function loadPezBuffer(buffer: ArrayBuffer, sourceName: string): Promise<void> {
  if (!isPez(buffer)) throw new Error('这不是 .pez 文件（ZIP 头不对）');

  const pkg = loadPez(buffer);
  const parsed = parseChart(pkg.chart);

  chart = parsed;
  chartName = sourceName;
  renderer.setChart(parsed);
  session.setChart(parsed);

  clock.stop();
  input.reset();
  const audioBytes = pkg.audioName ? (pkg.files.get(pkg.audioName)!.buffer as ArrayBuffer) : null;

  if (audioBytes) {
    setStatus('正在解码音频…');
    await clock.decode(audioBytes);
  }

  if (artUrl) URL.revokeObjectURL(artUrl);
  artUrl = null;
  if (pkg.imageName) {
    const data = pkg.files.get(pkg.imageName)!;
    artUrl = URL.createObjectURL(new Blob([data as BlobPart]));
    document.body.style.backgroundImage = `url(${artUrl})`;
  } else {
    document.body.style.backgroundImage = '';
  }

  const duration = clock.duration || parsed.durationSeconds;
  const seek = $<HTMLInputElement>('seek');
  seek.max = String(Math.max(0.01, duration));
  seek.value = '0';

  setStatus(audioBytes ? '' : '这个谱面包里没有音频，只能看谱面', audioBytes ? 'info' : 'error');
  $('play').textContent = '播放';
  updateChartInfo();
  renderGameHud(true);
}

async function loadPezFile(file: File): Promise<void> {
  void clock.resume();
  setStatus(`正在读取 ${file.name} …`);
  try {
    await loadPezBuffer(await file.arrayBuffer(), file.name);
    startPlaying();
  } catch (err) {
    setStatus(`加载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** 切到游玩画面并从头开始播放 */
function startPlaying(): void {
  showScreen('play');
  restartSession();
  clock.seek(0);
  void clock.resume().then(() => {
    clock.play(0);
    $('play').textContent = '暂停';
  });
}

// —————————————— HUD ——————————————

const lastHudPaint = { score: -1, combo: -1, counts: '', grade: '', rank: '' };

function renderGameHud(force = false): void {
  const hud = $('hud');
  if (!chart || !playMode) {
    hud.hidden = true;
    $('combo').hidden = true;
    $('judge-text').hidden = true;
    return;
  }
  hud.hidden = false;

  const s = session.stats;
  if (force || s.score !== lastHudPaint.score) {
    $('score').textContent = String(s.score).padStart(7, '0');
    lastHudPaint.score = s.score;
  }
  if (force || s.rank !== lastHudPaint.rank) {
    $('rank').textContent = s.rank;
    lastHudPaint.rank = s.rank;
  }

  const counts = `${(s.accuracy * 100).toFixed(2)}%　P ${s.perfect}　G ${s.good}　M ${s.miss}　共 ${s.total}`;
  if (force || counts !== lastHudPaint.counts) {
    $('counts').textContent = counts;
    lastHudPaint.counts = counts;
  }

  const comboEl = $('combo');
  const combo = s.combo >= 2 ? s.combo : 0;
  if (force || combo !== lastHudPaint.combo) {
    comboEl.hidden = combo === 0;
    if (combo > 0) comboEl.textContent = String(combo);
    lastHudPaint.combo = combo;
  }

  const judgeEl = $('judge-text');
  const age = chartSeconds() - session.lastGradeAt;
  const label =
    session.lastGrade !== null && age >= 0 && age < 0.45 ? GRADE_LABEL[session.lastGrade] : '';
  if (force || label !== lastHudPaint.grade) {
    judgeEl.hidden = label === '';
    judgeEl.textContent = label;
    if (label) judgeEl.dataset.grade = String(session.lastGrade as Grade);
    lastHudPaint.grade = label;
  }
}

// —————————————— 交互 ——————————————

async function togglePlay(): Promise<void> {
  if (!chart) return;
  if (clock.isPlaying) {
    clock.pause();
  } else {
    await clock.resume();
    // 播完之后再按播放就从头开始，同时重开一局
    const end = clock.duration || chart.durationSeconds;
    if (clock.duration > 0 && clock.seconds >= end - 0.05) {
      clock.seek(0);
      restartSession();
    }
    clock.play(clock.seconds);
  }
  $('play').textContent = clock.isPlaying ? '暂停' : '播放';
  updateChartInfo();
}

function seekTo(seconds: number): void {
  clock.seek(seconds);
  // 时间轴往回跳会让判定状态失效，直接重开一局
  restartSession();
  updateChartInfo();
}

$('go-import').addEventListener('click', () => showScreen('import'));
$('import-back').addEventListener('click', () => showScreen('home'));
$('play-back').addEventListener('click', () => showScreen('home'));
$('go-resume').addEventListener('click', () => {
  if (!chart) return;
  showScreen('play');
  updateChartInfo();
  renderGameHud(true);
});

$('play').addEventListener('click', () => void togglePlay());
$('restart').addEventListener('click', () => seekTo(0));
$('file').addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) void loadPezFile(file);
});
$<HTMLInputElement>('seek').addEventListener('input', (event) => {
  seekTo(Number((event.target as HTMLInputElement).value));
});

$('mode').addEventListener('click', () => {
  playMode = !playMode;
  clock.pause();
  $('play').textContent = '播放';
  restartSession();
  updateChartInfo();
  renderGameHud(true);
  setStatus(playMode ? '游玩模式：按住画面任意位置判定，D/F/J/K 也可以' : '观赏模式：只播放，不判定');
  setTimeout(() => setStatus(''), 2600);
});

function nudgeOffset(deltaMs: number): void {
  clock.offset = Math.round((clock.offset + deltaMs / 1000) * 1000) / 1000;
  localStorage.setItem(OFFSET_KEY, String(clock.offset));
  updateChartInfo();
}
$('offset-earlier').addEventListener('click', () => nudgeOffset(-10));
$('offset-later').addEventListener('click', () => nudgeOffset(10));

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    if (screen === 'play') void togglePlay();
    else if (screen === 'import') showScreen('home');
    return;
  }
  if (screen !== 'play') return;
  if (event.key === 'r') {
    seekTo(0);
  } else if (event.key === 'Escape') {
    showScreen('home');
  } else if (event.key === 'ArrowLeft') {
    seekTo(clock.seconds - 5);
  } else if (event.key === 'ArrowRight') {
    seekTo(clock.seconds + 5);
  } else if (event.key === '[') {
    nudgeOffset(-10);
  } else if (event.key === ']') {
    nudgeOffset(10);
  }
});

// 拖放：在任何画面都能用，松手就直接开始
document.body.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
  $('drop-zone').classList.add('hot');
});
for (const type of ['dragleave', 'dragend'] as const) {
  document.body.addEventListener(type, () => {
    document.body.classList.remove('dragging');
    $('drop-zone').classList.remove('hot');
  });
}
document.body.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  $('drop-zone').classList.remove('hot');
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadPezFile(file);
});

// —————————————— 渲染循环 ——————————————

const seekEl = $<HTMLInputElement>('seek');
const timeEl = $('time');

let lastHudAt = 0;
app.ticker.add(() => {
  if (!chart) return;
  const seconds = chartSeconds();

  // 输入要在本帧推进之前处理，而且用的是事件发生时的时刻
  if (playMode && clock.isPlaying) {
    for (const event of input.poll()) session.handleInput(event);
    session.update(seconds, input.pointersDown);
  } else {
    input.poll();
  }

  renderer.render(chart, seconds, playMode ? session : undefined);

  const now = performance.now();
  if (now - lastHudAt < 50) return;
  lastHudAt = now;

  renderGameHud();
  const duration = clock.duration || chart.durationSeconds;
  if (!seekEl.matches(':active')) seekEl.value = String(Math.min(clock.seconds, duration));
  timeEl.textContent = `${formatTime(clock.seconds)} / ${formatTime(duration)}`;
});

declare global {
  interface Window {
    /**
     * 调试钩子。浏览器在标签页不可见时会停掉 requestAnimationFrame，
     * 于是 Pixi 的 ticker 不再运行、画面既不会更新也不会出帧。
     * 这个方法手动完成「更新 + 出帧」，自动化截图和排查渲染问题都靠它。
     */
    hyw?: {
      renderAt(seconds: number): Record<string, unknown> | null;
      info(): Record<string, unknown> | null;
      /** 判定状态，自动化测试和调难度时用得上 */
      game(): Record<string, unknown> | null;
      setMode(mode: 'play' | 'watch'): void;
      screen(): string;
      open(url: string, name?: string): Promise<void>;
      readonly library: readonly { name: string; url: string }[];
      readonly clock: SongClock;
      readonly session: PlaySession;
      readonly input: InputTracker;
    };
  }
}

window.hyw = {
  renderAt(seconds: number): Record<string, unknown> | null {
    if (!chart) return null;
    renderer.render(chart, seconds - chart.meta.offset, playMode ? session : undefined);
    // ticker 停摆时 Pixi 不会自己出帧，这里显式渲染一次
    app.render();
    return { ...renderer.lastFrame };
  },
  info(): Record<string, unknown> | null {
    if (!chart) return null;
    return {
      name: chart.meta.name,
      lines: chart.lines.length,
      notes: chart.totalNotes,
      maxCombo: chart.maxCombo,
      durationSeconds: Number(chart.durationSeconds.toFixed(3)),
      audioSeconds: Number(clock.duration.toFixed(3)),
      playing: clock.isPlaying,
      mode: playMode ? 'play' : 'watch',
      screen,
      seconds: Number(chartSeconds().toFixed(3)),
    };
  },
  game(): Record<string, unknown> | null {
    if (!chart) return null;
    const upcoming = session.judgeNotes
      .filter((n) => !n.resolved)
      .slice(0, 6)
      .map((n) => ({
        type: n.note.type,
        at: Number(n.hitSeconds.toFixed(4)),
        x: n.note.positionX,
      }));
    return {
      mode: playMode ? 'play' : 'watch',
      seconds: Number(chartSeconds().toFixed(4)),
      pointers: input.pointersDown,
      stats: session.stats,
      lastGrade: session.lastGrade,
      upcoming,
    };
  },
  setMode(mode: 'play' | 'watch'): void {
    playMode = mode === 'play';
    restartSession();
    updateChartInfo();
    renderGameHud(true);
  },
  screen: () => screen,
  open: (url: string, name = 'chart') => openFromLibrary(url, name),
  library: chartLibrary,
  clock,
  session,
  input,
};

// —————————————— 启动 ——————————————

renderChartList();
showScreen('home');
// ticker 在菜单画面不需要跑，进游玩画面时再启
app.ticker.stop();
