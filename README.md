# hyw

Phigros 谱面预览与游玩 —— 在浏览器里导入 `.pez` 谱面包，让谱面自己跑一遍看效果，或者亲自上手打。

基于 Vite + TypeScript + Pixi.js，自带一套 RPE 谱面解析器和判定层。

## 功能

- **观赏模式**：只按谱面播放，不做判定，用来检查谱面写出来的观感。
- **游玩模式**：带判定和计分，结算给出准确率与评级。
- 支持 RPE 扩展事件：判定线换成图片、染色、拉伸缩放，以及在判定线上显示文字。
- 支持拖拽导入 `.pez`，也可以把谱面放进项目的 `charts/` 目录常驻谱面库。
- 可微调判定偏移，用来对齐不同设备的音频延迟。

## 环境要求

Node.js `^20.19.0 || >=22.12.0`（下限由 Vite 8 决定）。

## 快速开始

```bash
npm install
npm run dev
```

然后打开终端里给出的地址。

### 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 类型检查通过后打包到 `dist/` |
| `npm run preview` | 预览打包产物 |
| `npm run check` | 只做类型检查（`tsc --noEmit`） |
| `npm run check:judgment` | 运行判定层自检脚本 |
| `npm run check:text` | 运行文字事件自检脚本（显示时长、清除、打字机） |

## 操作

- `空格`：开始 / 暂停
- `D` `F` `J` `K`：也可以当点按用
- 游玩界面下方可以拖动进度条、切换观赏 / 游玩模式、微调判定偏移

## 导入谱面

两种方式：

1. 在「导入谱面」页把 `.pez` 拖进拖放区，或点「选择文件」。
2. 把 `.pez` 放进项目根目录的 `charts/`，刷新页面即会出现在谱面库里。

第二种方式走的是构建期的 `import.meta.glob`（见 `src/ui/chartLibrary.ts`），
所以放进去之后要刷新页面，不需要维护任何清单文件。

`.pez` 本质是个 ZIP 包，内含一份 RPE 谱面 JSON、音频、曲绘和 `info.txt` 元数据。

## 项目结构

```
src/
  chart/     RPE 谱面解析：.pez 解包、事件解析、缓动函数
  game/      输入跟踪、判定规则、一次游玩的状态机
  render/    Pixi.js 谱面渲染
  audio/     基于 Web Audio 的歌曲时钟
  ui/        谱面库与界面切换
tools/       判定层自检脚本
```

判定参数全部集中在 `src/game/judgment.ts`，每一条都注明了假设，想调手感改这一个文件就可以。
改完记得跑 `npm run check:judgment`——它会合成一份 BPM 60 的谱面，断言各评级边界、
Drag / Flick / 长按的行为以及计分公式。

判定线的长度和粗细由 `src/chart/textures.ts` 的 `DEFAULT_LINE_UNITS` 决定（谱面包里没有
`line.png`，用的是兜底值），粘贴面的扩展 `scaleX`/`scaleY` 是**直接倍数**：1 = 贴图自然大小，
负数是绕 anchor 镜像。

## 许可证

源代码以 **MIT** 许可证授权，见 [LICENSE](LICENSE)。

`charts/` 目录下的全部资产（音频、插画、谱面数据及元数据）**不在 MIT 授权范围内**，
版权归作者所有、保留一切权利，详见 [NOTICE](NOTICE)。

构建产物中打包了以下依赖，其许可证要求保留版权声明，同样列在 [NOTICE](NOTICE) 中：
pixi.js（MIT）、fflate（MIT）。

本项目为爱好者作品，与 Phigros 及其开发方 Pigeon Games 无任何关联。
