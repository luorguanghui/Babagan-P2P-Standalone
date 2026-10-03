# TURN 路径标识与 SFU 动态帧率诊断（2026-10-02）

## 用户现象与确认范围

用户报告内置采集 60 fps、1080p，SFU 实际上行接近 15 Mbps，大幅运动时编码约 30 fps，安卓接收统计约 20 fps；标为 Cloudflare TURN 的路径可接近 60 fps。尚无原场景的编码耗时、限制原因、到达帧率和解码耗时记录。

软件配置了 Cloudflare TURN：Worker 生成短期 ICE 凭据，P2P WebRTC 连接使用 Cloudflare 的 STUN/TURN；SFU 屏幕共享期间，通话语音继续走 P2P/TURN。SFU 视频是共享者单路发布，再分别向观看者转发。

发现并修复路径误标：原代码只要候选 URL 含 `cloudflare.com` 就判定 TURN，会把 `stun:stun.cloudflare.com:3478` 的 srflx 直连候选误标为 TURN。现在依据实际 relay 候选、relayProtocol 或 turn/turns 地址判断。因此原来的 TURN 标识不能单独证明该视频确实经 TURN 中继。

## 本次修改

- SFU 硬件编码优先普通 H.264 Main，再保留普通 Baseline 和 RTX 协商回退，继续避免 Constrained Baseline 在 NVIDIA 上回退软件编码的已知路径。P2P 原有档位选择保留。
- SFU 接收端在回答 offer 前优先 Main，同时保留其他 H.264 档位和 VP8。若云端 offer 不包含 Main，仍会协商其支持的档位；没有改写服务器 SDP。
- SFU 统计区分完整帧到达、解码、丢弃、单帧解码耗时，补充带宽估计、协商档位及浏览器可用时的解码器实现信息。统计优先选择持续产生流量的 RTP 报告，避免保留的旧 SSRC 干扰。
- 保留“maintain-resolution”与 1080p 的 15 Mbps 自适应上限。本轮没有强制提高带宽，也没有通过自动降分辨率掩盖帧率问题。60 fps 是目标上限，浏览器仍可在编码或带宽压力下降低实际帧率。
- SFU 探测脚本使用隔离应用配置。此前用于强制测试 Main 的“兼容编码”勾选状态曾影响后续非隔离探测；现已消除测试配置串扰，没有重置用户的实际应用设置。

## 验证结果

- 121 项单元测试、完整 ESLint、资源构建与 diff 检查通过；两轮独立代码复核没有发现新的 P1/P2 问题。
- 离线同源高动态 I420 比较：普通 Baseline 和 High 在 1080p60、15/30 Mbps 上限下均可编码约 60 fps，观察到 NVENC 会话，未发现固定 30 fps 限制。
- 真实 Cloudflare SFU、同一组交替亮度 I420 合成画面：Baseline 约 5.0 Mbps，Main 约 1.08 Mbps；两者采集与编码均约 55–56 fps。Main 编码约 5.6–6.3 ms/帧，NVENC 会话可见。这是该可压缩合成画面的比较，不能将约 78% 的码率差直接推广至所有游戏或视频。
- 打包后的 Windows 在线验证：Main 发布成功，采集/编码约 55.3–55.7 fps；接收约 55.3–55.7 fps、丢弃 0 fps、解码约 3.5 ms/帧。接收端是 headless Chrome，**不是安卓真机**。
- 此次云端接收 offer 最终仍协商为 Baseline，统计中的档位表示 SDP 协商参数；不能将它直接当成实际 H.264 SPS 位流档位。Main 接收偏好只在 offer 支持相应格式时生效。没有宣称安卓协商档位或解码吞吐已经验证。
- 安卓包 v2/v3 签名通过，19 个客户端资源逐一匹配当前源码，含编译 Activity；签名与上一条交付的 Quality-Fix APK 相同，可以覆盖该修复包。与最早保留的旧 1.19 的签名仍不同。

## 产物

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `releases/sfu-fps-fix-2026-10-02/Babagan-P2P-1.19-SFU-FPS-Fix-Windows-x64.exe` | 109080430 | `740b9cff3088334bd78ef48edb59e8ddcb271551740d47f501515fd89edee9bb` |
| `releases/sfu-fps-fix-2026-10-02/Babagan-P2P-1.19-SFU-FPS-Fix-Android.apk` | 63239 | `859942932a2c51669c5189663fb37463ffa894143214530092196ac1bb2f8cd7` |

## 仍需原场景数据

在 Windows 选择 60 fps，并先关闭“SFU 兼容编码模式”，用同一画面复测。安卓“到达”高而“解码”低时，应检查本机解码、缓冲与丢帧；两者都低时，继续对照发送端编码、网络及 SFU 下行。采集 60 fps 且实际发送到 15 Mbps，说明采集仍活跃并且接近当前码率上限，不能仅据此判定网络带宽不足或编码器过载。

原来游戏大幅变化时的 30/20 fps 现象尚未在用户设备上复现，本包是有实测依据的编码优化与诊断补全，**不构成安卓已恢复 60 fps 的声明**。

参考：[Cloudflare TURN 与 SFU 的区别](https://developers.cloudflare.com/realtime/turn/faq/)、[Realtime SFU 支持的编码](https://developers.cloudflare.com/realtime/sfu/platform/limits/)、[Android 支持的媒体格式](https://developer.android.com/media/platform/supported-formats)。
