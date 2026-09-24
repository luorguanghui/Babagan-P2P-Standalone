# Babagan P2P 独立客户端

Windows EXE 与 Android APK 都内置界面资源。语音与屏幕共享采用 WebRTC mesh，优先 P2P，无法直连时仅使用 Cloudflare TURN；不连接原 Fastify API、LiveKit 或 coturn。

Cloudflare Worker `babagan-p2p` 已部署到 `https://p2p.babagan.cloud`，用于入会、信令和短期 TURN 凭据。应用已内置该地址，可在“连接设置”修改。不需要自行运行服务器，但开会仍需要互联网和 Cloudflare 服务。

此公开项目按 GPLv2 提供源码；Windows 包内的 OBS 及相关组件源码、构建来源与许可说明见 [THIRD_PARTY_SOURCES.md](THIRD_PARTY_SOURCES.md)。1.13 的 EXE/APK 和对应源码归档均放在 GitHub Release，旧版本安装包保留在本地 `releases` 目录。

## 1.13 帧率多档位适配、系统音频回声抑制与主持人屏幕共享授权

针对显卡高负荷降级优化、系统音频共享混音回声及会议屏幕共享权限控制进行系统级升级：
1. **多档位高帧率选择与自适应画质防雪崩**：扩充支持 30fps、45fps、50fps、60fps 档位；显卡高负载场景支持稳定选择 30/45/50fps 并匹配 `maintain-resolution` 策略与 67% 最低下限保护，杜绝 60fps 不满帧引起的 540p 恶性连环降解。
2. **系统声音共享回声精准消除**：原生 C++ 采集助手引入 Windows 原生 WASAPI Process Loopback 进程树排除模式（`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`），自动注入 Electron 进程树 PID，硬件级滤除会议自身通话声音，彻底消除系统音频共享时的回声；同时对 Web 共享模式启用 WebRTC 回声消除约束。
3. **主持人参会者屏幕共享权限管理**：新增房间级 `grant-share` 信令与状态同步，主持人可精细化授权/收回各参会者的屏幕共享权限；参会者端按权限动态置灰控制并给出友好状态提示；若共享中途被撤销可自愈停止并同步各端状态。

## 1.12 屏幕共享高帧率防掉帧与异常中断稳定性修复

针对内置 OBS 屏幕共享在 60fps 场景下的剧烈帧率波动（频发 60fps 骤降至 30fps）以及长时间共享突发被中断的问题进行彻底修复：
1. **启用 GPU 硬件视频编码加速**：在 Electron 主进程中注入硬件加速开关，解决 1080p/2K 60fps 回退至 CPU 软编（OpenH264）引发的单帧编码超标（25ms+）及 CPU Overuse 降帧。
2. **WebRTC 60fps 帧率优先降级策略（`maintain-framerate`）**：在 60fps 及高帧率模式下启用帧率优先，根除 WebRTC 原生引擎遇轻微扰动便强制对半腰斩帧率（60fps → 30fps）的缺陷，画质自适应交由上层平滑处理。
3. **内容提示动态切换（`contentHint = 'motion'`）**：60fps 场景启用运动内容提示，解除 Chromium 画面调度器对屏幕流的 30fps 帧率压制。
4. **主进程 IPC 双缓冲管道流控**：`NativeFrameGate` 升级支持 2 帧在途容量，消除 16.6ms 单帧乒乓 ACK 导致偶发丢帧跌落至 30fps 的流控瓶颈；队列容限平滑增至 4 帧。
5. **固定显示器物理句柄监听（`HMONITOR target_handle`）**：重构 C++ 助手检测循环，改用物理句柄直接查询屏幕尺寸，杜绝 Windows 多屏/显卡切换时 `EnumDisplayMonitors` 顺序跳变引发的误退出（Exit Code 20 导致共享被停）。
6. **时间戳严格单调保护与 stdout 4MB 高性能缓冲**：从源头杜绝时间戳倒退异常引发的服务强杀；采用 `thread_local` 帧缓存复用，杜绝高频堆分配碎片与管道写阻塞。
7. **信令网络瞬断自愈续租**：优化 WebSocket 短暂断线逻辑，重连期间保护本地共享轨道不被误销毁，连通后自动续租恢复共享。

## 1.11 屏幕共享大动态画质防模糊与抗色块优化

针对内置高帧率 OBS 采集及屏幕共享在大动态画面下突发模糊、大范围色块的问题进行系统性修复：
1. **防止静态画面虚假拥塞压降**：重构 `adaptBudget`，区分空闲低发送量与真实网络拥塞，避免因静止画面导致 GCC 探测值下降被误判为拥塞并锁死在 500 kbps 极端低码率。
2. **动态分辨率码率下限兜底（`minBitrate`）**：按分辨率与目标帧率设定科学合理的码率下限（1080p60 最低 2.7 Mbps，4K 最低 6.75 Mbps），彻底杜绝剧烈运动时编码器因码率不足被逼至 QP 51 产生大面积色块。
3. **WebRTC 视频 SDP 增强与带宽头空间（`tuneVideoSdp`）**：注入 `x-google-min-bitrate`、`x-google-start-bitrate` 及 `b=AS` 会话带宽，开局即赋予充足码率，防止突发运动时编码器来不及拉升码率。
4. **编码内容提示校正为屏幕模式（`contentHint = 'detail'`）**：将视频轨道标记为 `detail`，通知底层编码器启用屏幕内容专用 QP 控制与清晰度优先模式，消除摄像头实时模式下的高 QP 糊化。
5. **优先协商 H.264 High Profile**：优先选用 High Profile（CABAC 熵编码 + 8x8 变换），大幅提升运动画面的压缩效率，减少色块失真。
6. **内置采集真实分辨率感知**：代理原生音视频轨道 `getSettings()`，真实反映采集到的物理屏幕尺寸，确保 2K/4K 高分屏获得相匹配的完整码率预算。

## 1.10 屏幕共享画质防抖与抗闪烁更新

深度借鉴开源项目 Piik 的流媒体传输与渲染设计：
1. **降级偏好优化**：编码偏好调整为 `maintain-resolution` 并引入启动保护，消除网络抖动时分辨率剧烈跳变的现象。
2. **码率与分辨率解耦**：码率自适应吸收短时波动，分辨率调整引入多窗口连续确认与整数对齐，杜绝分辨率“拉锯式”跳跃。
3. **全平台前后台挂起保护**：接入 `visibilitychange`、`freeze`、`resume` 等生命周期事件，后台挂起时冻结虚假降级，切回前台自动重置时间戳基准。
4. **双缓冲画面留存与 Compositor 确认**：修复 Canvas 尺寸重设白屏，配合 `requestVideoFrameCallback` 实现无缝帧过渡，彻底根除分辨率切换时的闪屏与“等待屏幕共享”占位卡片闪现。

## 1.09 自适应带宽调整

移除 1.0.8 试验版的房间级总上行预算和手动总上行上限。每条接收连接根据自己的 WebRTC 可用带宽、丢包和延迟继续自适应；多个接收者的可用带宽估计取平均，作为加快上探的参考值，不再作为共同的硬性码率上限。各画质档位仍有每人最高码率和最高自动增强分辨率：720p → 1080p / 10 Mbps，1080p → 1440p / 15 Mbps，1440p → 2160p / 20 Mbps，2160p → 2160p / 30 Mbps。原始分辨率模式按实际源尺寸选择相应码率上限，不放大超过源尺寸。多名接收者的实际总上行仍会随人数增长，请观察界面统计。

## 1.0.8-experimental.2 内置采集试验版

本次更新把共享视频的自动/手动总上行上限提高至 50 Mbps；观看端在自动分辨率切换时保留上一帧，收到新帧后再显示，避免短暂闪出“等待共享”的占位图。其余验收边界沿用 1.0.8-experimental.1。

Windows 增加“内置高帧率屏幕采集（实验）”，把精简 libobs 核心、显示器采集和 WASAPI 系统声音随 EXE 一起打包；共享者运行时无需安装 OBS。该模式目前支持整个屏幕，单个窗口仍使用“屏幕 / 窗口”来源。OBS 虚拟摄像头来源继续保留。内置采集的视频和系统声音使用同一时间轴，接收端在同一媒体元素播放；麦克风独立。最多四名接收者共享同一个发送视频总码率预算，并可在“共享视频总上行上限”手动设为 4–50 Mbps。

目前仅完成本机采集、局域 WebRTC 和单接收者音画轨道验证。10 分钟后台测试中采集约 60 fps、编码中位数 60.1 fps，但有一个 10 秒编码窗口为 49.4 fps，未满足严格的无低帧窗口门槛；显示模式切换、四人真实网络、Android 真机音画偏差和相对 OBS 的延迟尚未验收。因此此版本保持“实验”标识，1.0.7 仍是已验收版本。

构建 Windows 试验版前需在构建机安装 OBS Studio 32.1.2、Visual Studio C++，并取得同版本官方源码头文件；最终用户无需这些构建依赖。先运行 `native/capture-helper/build.cmd` 与 `native/capture-helper/stage.ps1`，再运行 `pnpm package:win`。OBS 核心按 [GPLv2](https://github.com/obsproject/obs-studio/blob/32.1.2/COPYING) 分发；对外提供安装包时还须同时提供符合许可证要求的对应源码与依赖许可信息。当前本地试验包不应视为已完成对外分发审查。

## 使用

1. Windows 10/11 x64：运行 `Babagan-P2P-1.13-Windows-x64.exe`，这是便携版，首次启动会解压运行文件。EXE 没有商业代码签名证书。
2. Android 8.0 及以上：安装 `Babagan-P2P-1.13-Android.apk`，首次开麦时允许麦克风权限。APK 使用本机生成的发布密钥签名，依赖系统 Android WebView。1.0.5 及其后版本使用相同签名密钥，可覆盖升级。**当前目录内的 1.0.4 APK 使用另一签名证书，不能直接覆盖安装新版；请在会议结束后卸载 1.0.4，再安装 1.13，并重新填写名字等本地设置。**
3. 填写名字并“创建会议”，将“复制邀请”得到的链接发给其他人。对方在安装好的客户端粘贴邀请并加入。邀请链接不是网页会议入口。
4. 每房最多 5 人。Windows 可选择共享屏幕/窗口或 OBS 虚拟摄像头；屏幕/窗口共享可选系统声音。Android 支持语音及观看，不支持发起屏幕共享。
5. Android 当前应保持前台使用；切到后台会暂停麦克风，不承诺锁屏通话。语音默认开启回声消除。
6. 主持人可结束会议。房间 24 小时到期；离线席位保留 2 分钟供重连。界面显示每位成员实际使用的 P2P 或 Cloudflare TURN 路径。

长期 TURN 密钥仅在 Cloudflare Worker 的 `TURN_KEY_ID` / `TURN_API_TOKEN` Secret 中。安装包不包含长期密钥。房间码是邀请凭证，应只发给参会者。

## 构建

项目根目录使用 Node 24 / pnpm 10：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm lint
./scripts/prepare-native.ps1 -ObsRoot 'C:/Program Files/obs-studio'
pnpm package:win
./scripts/build-android.ps1 -SdkRoot C:/path/android-sdk -JavaRoot C:/path/jdk
```

Windows 构建机需安装 Visual Studio C++ 与 OBS Studio 32.1.2；`prepare-native.ps1` 会取得固定的 OBS 源码版本并把最小运行库暂存在 `native/runtime`。最终用户无需安装 OBS。构建脚本在独立临时目录打包，再把 EXE 复制到项目 `releases`；Android APK 也输出到 `releases`。这两个目录中的编译产物不纳入 Git 源码历史，1.09 安装包作为 GitHub Release 附件提供。

Android 构建要求 Android SDK platform 35、build-tools 35.0.0 和 JDK（本次使用 JDK 22）。脚本使用官方 aapt/javac/d8/zipalign/apksigner；无需 Gradle。发布密钥保存在 `%LOCALAPPDATA%/Babagan/signing`，只有当前 Windows 用户可访问。**需要保留该目录才能签名兼容的后续更新，不能把它随安装包分发。**

## Worker 部署

```powershell
pnpm exec wrangler login
pnpm worker:deploy
pnpm exec wrangler secret put TURN_KEY_ID --config worker/wrangler.jsonc
pnpm exec wrangler secret put TURN_API_TOKEN --config worker/wrangler.jsonc
```

不要将长期密钥写进源码、`.env.example`、构建目录或客户端。Cloudflare 账号当前已配置两项 Secret，重复部署代码不需要重新创建 TURN 应用。

## 验证

```powershell
pnpm test
pnpm lint
$env:WORKER_URL='https://p2p.babagan.cloud'
$env:REQUIRE_TURN='1'
node test/worker-smoke.mjs
$env:RELAY_ONLY='1'
node test/media-smoke.mjs
node test/desktop-smoke.mjs
```

媒体测试使用项目现有 Playwright 浏览器，若版本不一致，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定测试用 Chromium。测试只使用合成音频/屏幕；Android 真机音频路由、Windows 实际系统声音采集和跨运营商长时间通话仍需要设备验收。

本版本保留语音、屏幕共享与会议基础控制；原网页的账号/管理密码、共享授权、踢人、手工编码和码率面板没有迁移到独立界面。

## 1.0.7 OBS 虚拟摄像头共享

Windows 端现有“共享来源”新增“OBS 虚拟摄像头”。在 OBS 中添加“显示器采集”，到“设置 → 视频”按需设置画布、输出分辨率和 60 FPS，然后在 OBS 控制区点击“启动虚拟摄像头”。进入会议后选择“OBS 虚拟摄像头”及“目标 60 fps”，点击“共享 OBS”。软件只会按设备名选择 OBS 虚拟摄像头，不会误用实体摄像头。停止共享会释放摄像头轨道；切回“屏幕 / 窗口”仍可使用原选择器。

OBS 来源只提供视频画面；麦克风继续使用会议内的开关。“系统声音”选项在 OBS 模式下不可用。OBS 负责采集，会议软件继续用 WebRTC 编码发送；这一路径不会调用 Electron 屏幕采集器。若找不到设备或访问被拒绝，界面会给出具体提示。改变会议内的目标帧率只改变发送上限；OBS 自身的输出帧率应在 OBS 视频设置中调整。取流期间共享按钮会禁用；离会或重连会取消未完成的取流并释放迟到的视频轨道。

本机 OBS Virtual Camera 实测输出 2560×1440 / 60 fps。真实 OBS→Windows 客户端→另一观看端测试中，最小化客户端后采集 59.9 fps、发送 59.9 fps、接收解码 59.7 fps，编码器为 NVIDIA H.264 Encoder MFT。本次测试的自动画质降到 960×540；固定 1080p 设置也可能被浏览器带宽控制降分辨率，60 fps 不代表始终保有 1080p 清晰度。

## 1.0.6 H.264 硬件编码优先

双方在建立连接时优先协商 H.264，并保留 VP8 等编码格式作为兼容后备。Windows 本机的 RTX 4070 Ti 实测从默认 VP8 `libvpx` 软件编码切换到 H.264 `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)` 硬件编码；其他设备是否使用硬件编码取决于其驱动和 Chromium 实现。硬件编码不可用时继续共享，并在发送统计中显示实际编码器和软件/硬件状态。

1080p 发送尺寸不再把 1440p→1080p 的精确 `4/3` 缩放比舍入为 `1.33`。舍入曾产生 1925×1083 奇数尺寸，与硬件编码回退为 `OpenH264` 软件编码同时出现；现在发送缩放兼顾两轴偶数尺寸，在其他屏幕比例和自动画质档位也避免奇数输出。实测修复后 H.264 在前后台均持续使用 NVIDIA 硬件编码。屏幕采集本身若降低帧率，硬件编码无法补出未采集的帧，诊断栏会分别显示“采集”和“发送”帧率。Windows 防休眠锁只在实际共享期间启用。

## 1.0.5 前后台帧率诊断与保帧率回退

安卓端是观看端，不发起屏幕共享；诊断栏不再显示容易误解的本机“目标 30 fps”，而显示实际视频帧的到达和解码帧率。Windows 发送端同时显示屏幕采集帧率与编码发送帧率，便于判断帧率下降发生在采集还是编码阶段。

在原有“固定画质上限”模式中，若屏幕采集仍接近目标帧率而编码连续两次统计低于目标的 75%，客户端会逐步降低发送分辨率，优先恢复帧率；稳定后缓慢恢复分辨率。屏幕内容不变化导致采集本身低帧率时，不会无意义地降画质。60 fps 仍受屏幕内容、编码器、设备性能与网络条件限制。

已核对当前目录的 1.0.4 APK 证书指纹为 `7b84351e…cd829ef`，1.0.5、1.0.6 和 1.0.7 为 `a1599a0e…92191f8b`。本机未找到 1.0.4 私钥，因此无法制作从 1.0.4 直接覆盖安装的 APK；若保留了旧签名密钥，可用其重新签署新版。

## 1.0.4 连接路径、画质恢复与复制提示

连接标记优先读取 WebRTC 实际选中的候选对，避免 ICE 重选后把旧直连候选对误报为 P2P；候选对不明确时显示“路径待确认”。动态画面的发送码率上限在网络估计高于当前上限时可逐步恢复，避免持续卡在 0.5 Mbps。浏览器和网络仍决定实际发送速率；如果带宽估计本身只有约 1 Mbps，客户端无法保证更高吞吐。复制邀请的成功提示 2.5 秒后消失，复制失败时显示的手动复制提示 5 秒后消失。

## 1.0.1 更新

内置 p2p.babagan.cloud；自动迁移旧默认地址和旧邀请，保留自定义服务地址。Windows 共享选择器新增窗口与屏幕缩略图、分类切换、手动刷新、明确选中后确认与取消。缩略图是本地快照，最小化或受保护窗口可能无法提供预览。


## 1.0.3 原始分辨率与自动画质

默认原始分辨率 / 30fps，支持 60fps。捕获不设置固定宽高或比例；4:3、超宽屏、竖屏均按源尺寸捕获。可手动选择 720p/1080p/1440p/2160p 作为等比例发送基准。自动模式优先帧率，根据每条连接的带宽估计、丢包、延迟和编码负载逐步上探或回退；网络不足时可等比例降分辨率。关闭自动模式可保持选定发送尺寸上限，但浏览器拥塞控制仍可能降质。

原始模式已经使用源像素，不进行无效放大；手动低分辨率基准下，稳定高带宽可发送更多源像素供观看端缩小显示。主页显示实际码率、帧率和分辨率。60fps 是目标，不保证源或硬件达到。统计不是独立网络测速，静态屏幕实际帧率可能很低。
