import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    /*
     * 监听所有网卡。两个作用：
     *   1. 局域网里用手机直接开 http://<本机IP>:5173/ 测试（音游的触屏手感只能在真机上试）
     *   2. 内网穿透工具（frp 等）回源。默认只绑 localhost 时它连 127.0.0.1:5173 会连接失败
     */
    host: true,

    /*
     * Vite 会校验请求的 Host 头以防 DNS rebinding，不认识的域名直接返回
     * 「Blocked request. This host is not allowed.」。
     * 穿透用的域名要在这里列出来（以 . 开头表示连同子域名一起放行）。
     */
    allowedHosts: ['sh.harmoon.cn', '.harmoon.cn'],

    /*
     * 如果穿透后页面上 HMR（热更新）连不上、控制台报 websocket 错误，
     * 多半是隧道对外的协议/端口和内部不一致（比如对外是 https 443）。
     * 那时候把下面这段打开，端口改成隧道对外的那个：
     *   hmr: { protocol: 'wss', clientPort: 443 },
     * 注意：HMR 连不上不影响游玩，只是改代码后要手动刷新。
     */
  },
});
