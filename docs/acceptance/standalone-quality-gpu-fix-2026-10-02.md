# 分辨率稳定与内置采集减负修复（2026-10-02）

本次提供 1.19 的独立 Windows 和 Android 修复试用包，保留原有 EXE、APK 及此前工作区修改。未部署 Worker，未发布远端版本。

## 诊断与修改

- 确认 P2P 存在应用层与 WebRTC GCC 重复控制的反馈环：1080p60、零丢包、25 ms RTT、浏览器估计 1.2 Mbps 时，原控制器将 8 Mbps 上限压到 1.08 Mbps，随后在 1.2–1.38 Mbps 徘徊。现在保持所选档位的发送上限，实际发送量由 GCC 控制；静态内容仍允许低码率，不以填满链路为目标。SFU 原有上限配置没有这层反馈环。
- P2P 和 SFU 优先保持所选分辨率；取消 P2P 自动升降分辨率以及 60 fps 的 balanced 偏好。遇带宽或编码压力，浏览器可调整实际码率和帧率。
- 播放正常时不再每 250 ms 将视频画面复制到 canvas；仅启动、暂停、轨道替换和过渡时留存画面。空闲及后台取消帧回调；暂停及轨道替换前留存当前帧。
- Electron 失焦或最小化时暂停并隐藏本机静音预览，采集轨道、P2P/SFU 发送和远端声音继续运行；回到前台恢复预览。使用原生窗口状态，因为禁用后台节流后 document.hidden 不足以判断窗口可见性。
- 内置采集中调节帧率和画质时同步重配采集助手，保留同一轨道、共享源及系统音频选项，并屏蔽旧助手的事件。新帧尺寸变化会通知发送端重新缩放，避免 SFU 用旧尺寸计算缩放比例。
- 内置视频将独占 ArrayBuffer 的所有权交给 VideoFrame，减少重复内存复制，并标记 OBS 输出使用的 BT.709 色彩空间。普通屏幕及 OBS 来源同步施加帧率上限。

## 验证

- 119 项单元测试通过；完整 ESLint、资源构建和 git diff --check 通过。
- 真实内置采集助手从 1080p60 改为 720p30：实际采集 60→30 fps；原始帧传输约 179→40 MiB/s，降低 78%。这是不同画质档位的传输量比较，不能换算成显卡性能提升百分比。
- 打包后的 Electron，真实内置采集经原 IPC、VideoFrame 和本机 P2P 发送：后台暂停预览后，编码帧数 39→73，发送保持 1920×1080，canvas 截图次数保持为 2；无页面或媒体错误。当前 Electron 实测支持 VideoFrame 缓冲所有权转移。
- 源码 Electron 在线 SFU 测试成功发送、接收合成 1920×1080 H.264 视频，NVIDIA NVENC 会话计数确认硬件编码运行。源码桌面完整入会/退出冒烟通过。
- 后续打包桌面在线入会与 headless Chrome SFU 冒烟未通过：最后一轮报 net::ERR_CONNECTION_CLOSED，独立 HTTPS 请求也在 TLS 建连时 ECONNRESET。更早的 headless SFU 尝试曾发生共享轨道结束；其具体触发路径尚未确认。打包桌面本地资源、选源器和离线原生 P2P 验证通过。跨浏览器线上 SFU 不计为通过。

## 产物与边界

- 路径：`releases/quality-fix-2026-10-02/Babagan-P2P-1.19-Quality-Fix-Windows-x64.exe`
- 大小：109,077,400 字节。
- SHA-256：`78c33ed63969c826c7f45a728d0ff672143b46f73a1ee474f81414c17e3a6416`。

### Android 修复包

- 路径：`releases/quality-fix-2026-10-02/Babagan-P2P-1.19-Quality-Fix-Android.apk`。
- 大小：63,239 字节；SHA-256：`ea54ebe577b64a01b05b72c3e7ca4f28fd61b85e0493f59c6d87d69754854e91`。
- `versionName=1.19`、`versionCode=22`，Android 8.0+；APK v2/v3 签名和 zipalign 检查通过，包含编译后的 Activity，19 个客户端资源逐一核对与本次源码一致。未进行安卓真机测试。
- 新包使用目前可找到的本机构建密钥，证书 SHA-256 为 `a1599a0e3f0bccdbfcf203738e23648b3e443bdab0c09b223aee12e292191f8b`；保留的旧 1.19 APK 证书为 `7b84351eb4df219a3630d89c594787862dcf9683cc44646bf6f9864cecd829ef`。两处本机 Babagan 签名目录的密钥均为前者，无法签出与旧 1.19 兼容的更新。因此当前旧 1.19 需要先卸载再安装修复包，卸载会清除应用本地设置；若取得旧签名私钥，可重新签署以保留覆盖安装能力。
- Android 构建脚本新增可选输出路径和签名目录参数，便于单独保存修复包并显式选择已有签名密钥；未覆盖原 APK，也未改动密钥内容。

尚未在用户原来出现 20–30% 性能损失的游戏或高负载场景中进行修复前后对照，因此不能宣称已恢复该百分比。内置 OBS 采集仍包含 GPU 读回、进程间传输和编码，P2P 多人仍需多路发送；本次消除额外截图、后台预览和无效采集调档的负担，没有把整条采集链改为 GPU 零拷贝。需要用户使用修复包在同一画质、帧率和负载下比较。

参考规范：[WebRTC 统计](https://www.w3.org/TR/webrtc-stats/)、[内容提示与降级偏好](https://w3c.github.io/mst-content-hint/)、[WebCodecs VideoFrame](https://w3c.github.io/webcodecs/#dictdef-videoframebufferinit)。
