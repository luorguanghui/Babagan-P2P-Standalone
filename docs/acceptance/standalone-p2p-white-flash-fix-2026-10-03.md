# PC 接收端 P2P 白闪修复（2026-10-03）

## 现场信息与结论边界

用户确认双方使用 `Babagan-P2P-1.19-SFU-FPS-Fix-Windows-x64.exe`，共享者使用内置 OBS，视频路径为 P2P 直连，PC 接收画面出现类似白闪。没有原现场录像、丢包统计或两台设备的显卡信息。

核对旧包的 `app.asar`：`share-stage-continuity.mjs`、`share-playback.mjs`、`video-codec.mjs` 与 `mesh.mjs` 均与本次开始时的工作区源码一致。已在旧包的真实 Electron 播放器中复现并修复**一条可以产生白闪的接收端缓存路径**。这不是对用户现场每次白闪均来自同一原因的断言。

## 已确认的问题与修改

1. 连续性模块启动时缓存视频截图，正常播放时不持续更新截图。当 `waiting` / `emptied` 到来且 `readyState < 2`，或 `drawImage` 失败，原代码仍依据 `hasSnapshot` 显示启动截图。视频已经从亮画面变为暗画面时，旧亮画面会突然覆盖播放器。旧包实测：缓存 RGB 为 `[255,255,255]`，重载后 `holdVisible=true`；修复版为 `holdVisible=false`。
2. 已经在轨道替换前留存当前帧时，后续 `resize` 会再次覆盖缓存。现在过渡期间保持已留存的画面，等新的视频帧到来再撤去覆盖层，避免把播放器的中间状态重复截图。
3. 实际共享结束后清除截图有效标记；无法取得当前帧的空屏过渡也使旧截图失效，避免重新入会或下一次共享再次显示历史亮帧。
4. 原播放协调函数在系统音频晚到或被替换时重新设置整个 `srcObject`，导致视频也重新加载。现在同一视频轨道的音频变动通过原 `MediaStream.addTrack/removeTrack` 完成，保留视频播放器；只有视频轨道确实改变时才重建流。

没有采用“检测白色就丢帧”的处理：正常共享白色文档、网页仍然应当显示。也没有恢复周期性 GPU→canvas 截图。此前排查时注意到的 SDP 最低码率仅属候选因素，本次没有足够证据将其与白闪关联，因此没有改动码率、编码档位或拥塞控制。

## 可重复验证

执行 `node test/p2p-flicker-smoke.mjs`。设置 `BABAGAN_EXE` 可以对旧包或新包的 `win-unpacked/Babagan P2P.exe` 执行相同测试；每次使用独立配置目录。

测试使用两个本机 UDP socket 改写候选端口，并核对被 ICE 实际选中的端口，确保故障注入确实经过 WebRTC 媒体链路。对 SRTP/SRTCP 约每 10 包丢弃 1 包，再阻断媒体 1.5 秒；STUN 与 DTLS 保留。本测试没有使用仅影响 HTTP 的网络模拟，也没有保存或上传桌面图像。

- 旧包：同一测试在白截图回放断言处失败，`holdVisible=true`，`holdPixel=[255,255,255]`。这是预期的修复前失败，不是新包验证失败。
- 源码与新包：暗色运动图案经 H.264/P2P 后，在丢包和断流期间进行独立于解码回调的显示采样；新包累计 1816 次采样未检出白色样本。判据为中心采样 RGB 三通道均大于 235，只针对受控暗色测试图，不能代表整个屏幕或任意真实内容均无单帧异常。
- 新包受控运动测试：解码帧数 124（断流时）→159（恢复后）；已记录丢包、NACK 与冻结计数。音频新增、替换、移除前后 `srcObject` 保持不变，`waiting/emptied` 计数均为 4，没有额外视频重载。
- 新包真实内置 OBS→原 IPC→I420 `VideoFrame`→P2P H.264→PC 解码：第二轮丢包和断流后，解码帧数 336→348，PLI 0→1，恢复成功。此段采集真实桌面，未对其做白帧判定，因此仅证明原生采集链路恢复，不代表用户原游戏或高 GPU 负载场景的视觉问题已消失。
- 127 项单元测试通过；完整 ESLint、资源构建、`git diff --check` 通过；新包独立桌面启动冒烟通过。独立代码复核没有发现新增的生产逻辑回归，并补充了截图失效、结束共享、绘制异常及 `timeupdate` 回退测试。

## 修复包

`releases/p2p-flicker-fix-2026-10-03/Babagan-P2P-1.19-P2P-Flicker-Fix-Windows-x64.exe`

- 大小：109,080,239 字节。
- SHA-256：`8a97b04b3c014c6ee5ce5b403c06022dee4aaa84440af813dd027c5d2c91268b`。
- 新旧包内客户端/桌面资源逐项比较，只有 `www/share-playback.mjs` 与 `www/share-stage-continuity.mjs` 发生变化；这两份新包资源逐字匹配当前源码。原包和工作区既有修改均保留。
- 原始测试数据位于同目录 `failed-probe.json`（旧包预期失败）、`source-probe.json` 与 `packaged-probe.json`。

优先在出现白闪的 PC 接收端使用新包；建议双方均使用同一修复包，再保持原画质、帧率、内置 OBS 与 P2P 设置复测。此次没有修改或部署 Worker。

若现场仍出现白闪，应记录发生时间、共享者本机预览是否同时变白、接收端网络/解码统计与显卡型号，继续区分源画面异常、解码损坏和 GPU 合成异常；本次本机故障注入无法排除这些设备相关因素。

媒体回调语义参考：[Video frame callbacks](https://wicg.github.io/video-rvfc/)。传输与恢复计数参考：[WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)。上述修复结论以本机旧包/新包对照与测试数据为依据。

## Android 重新打包

按用户后续要求，使用已有构建脚本与已有签名密钥生成 `releases/p2p-flicker-fix-2026-10-03/Babagan-P2P-1.19-P2P-Flicker-Fix-Android.apk`，保留原 APK。

- `versionName=1.19`、`versionCode=22`，最低 Android 8.0（API 26），目标 API 35。
- 大小：63,239 字节；SHA-256：`d5f13090c61e6cd810392da7184df7cd38e6edbd2289a3efca68e2e409daa458`。
- APK v2/v3 签名验证和 zipalign 检查通过；19 个客户端资源逐项 SHA-256 核对与当前源码一致，包含 9,392 字节 `classes.dex`。
- 签名证书 SHA-256：`a1599a0e3f0bccdbfcf203738e23648b3e443bdab0c09b223aee12e292191f8b`，与上一版 SFU-FPS-Fix APK 相同，支持覆盖该修复版。签名密钥未新建或修改。
- Java 编译有既有 Java 8 目标及弃用 API 警告，构建成功；没有进行安卓真机安装或媒体播放测试。
