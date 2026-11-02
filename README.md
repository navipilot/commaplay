# CommaPlay · 机械小鸽

运行在 **comma 3** 上的独立、实验性无线 CarPlay 接收模块。iPhone 提供
CarPlay 画面和声音，comma 转发媒体与触控，电脑或车机浏览器负责显示和播放。
不需要安装车机 App，不占用 openpilot 的屏幕和触摸输入。

**请只在驻车时配对、配置和测试。仅用于可信局域网，不要开放到公网。**

## 当前功能与验证范围

| 功能 | 当前状态 |
|---|---|
| 无线 CarPlay 画面、浏览器触控 | 已用真实 iPhone 验证 |
| 音乐播放 | 已验证真实 iPhone 的 48 kHz 双声道 AAC 在 HTTP 浏览器产生音频输出 |
| HTTP Opus 提示音 | Chromium 解码、音乐与提示音并行、音量和缓冲清理测试通过 |
| 主页面 | 等比例适配窗口，无侧栏；连接失败自动进入 Debug |
| Debug 设置 | 蓝牙配对、手机选择、显示参数、音量、音频与热点诊断 |
| 自动启动 | 已安装统一启动入口；设备重启后服务启动已有实机记录 |
| Tesla 特殊地址 | 热点自动 DNAT 已部署，隔离网络实测通过；Tesla 实车访问未验证 |
| Siri、通话、浏览器麦克风 | 未完成端到端验证；麦克风需要兼容的安全来源与授权 |
| iPhone 蓝牙共享上网（PAN） | 未实现；不能把蓝牙配对成功当作已共享互联网 |

合成测试画面、媒体解码测试和真实手机验证是不同证据，不等于所有车机都兼容。
浏览器缓冲已做低延迟追赶，但不承诺固定的端到端触控或音画延迟。

## 快速使用

### 普通局域网

1. comma 与浏览器设备加入同一可互通网络；iPhone 开启 Wi-Fi、蓝牙并保持解锁。
2. 打开 `http://<comma-IP>:8080/`。没有手机会话时会自动进入
   `http://<comma-IP>:8080/debug.html`。
3. 在 Debug 扫描并选择自己的 iPhone，核对手机与网页的配对码，再确认配对。
4. 点击「设为 CarPlay iPhone（下次启动生效）」。初次配置还需要有效的
   MFi 身份和匹配的 Wi-Fi 参数，见下文。
5. 接收器重新启动后处理手机授权提示，进入主画面并播放音乐。

**当前部署不需要 token、登录或私有链接。** Debug 不占用媒体控制连接，
但主画面只允许一个控制浏览器；换设备时先关闭旧主页面。

主页面连接失败约 8 秒后进入 Debug，连接后的首帧等待上限约 20 秒。
窗口变化只缩放画面，不自动改变接收分辨率；Debug 应用显示参数会重连 CarPlay。
推荐从 **H.264、1280×720、30 fps** 开始。

### 声音与全屏

声音在画面连接和音频配置到达时自动尝试播放，没有独立「启用声音」按钮。
如果浏览器拦截自动播放，首次触摸画面或操作页面时会自动重试授权；
不能绕过浏览器手势政策。音量在 Debug 调整。

HTTP 下，H.264/AAC 使用 MSE/fMP4，Opus 使用 MSE/WebM，LPCM 使用 Web Audio；
安全来源可使用 WebCodecs。comma 不解码、转码或从自己的扬声器播放这些媒体。
Opus 需要浏览器支持 `audio/webm; codecs="opus"`，Tesla 的实际支持仍需验证。

音频突发到达时合并追加，限制待写缓冲，不再因超过 64 个待写包永久关闭播放。
HTTP 视频按完整 GOP 清理旧缓冲，避免移除仍在解码的帧；静止画面的最后一帧也会提交。
普通静止或缓冲耗尽不会周期性重建播放器；只有实际 MSE 错误才限频尝试重建。
这些措施不能解决浏览器不支持 HEVC、热点干扰或过高分辨率，
优先使用上面的 H.264/720p 配置。

「全屏」按钮调用浏览器 Fullscreen API，需要用户手势。
自动适配窗口不等于能隐藏车机浏览器自身工具栏。

## 特斯拉连接 comma 热点

在 Debug 的 **「特斯拉热点连接」** 卡片查看实时状态和连接指引：

1. 驻车，在 comma 网络设置中开启热点。
2. 将 Tesla 连接到这个热点。
3. 等待 Debug 显示入口映射就绪，在车机浏览器打开：

   **`http://99.99.99.99:8080/`**

热点客户端仍使用正常私网地址，例如 `192.168.43.x`，不需要改成 `99.x`。
独立监测服务每 **2 秒**检查活动的 NetworkManager Wi-Fi AP/shared 连接，
仅将热点接口收到的 `99.99.99.99/32`、TCP 8080 流量 DNAT 到热点本机的
8080，HTTP 与 WebSocket 使用同一入口。

热点关闭或检测失败时撤销映射，接口/IP 改变时更新，服务停止时清理自有规则。
只管理 `iptables-legacy` 的 `COMMAPLAY_TESLA` 链和自己的 PREROUTING 入口，
不修改其他 NAT、不开启全局转发、不自动开关热点或修改 DNS。
Debug 在热点关闭、监测故障时隐藏入口链接，不把未知状态显示成可用。

**地址映射不等于整个热点 CarPlay 链路已经配置好：**

- 网络监测服务会自动识别活动 Wi-Fi；热点优先于并行的管理 Wi-Fi。
  自动匹配 SSID、密码、实际频道、IP 和 CarPlay 监听地址。
  连续两次检测稳定且有新鲜驻车/巡航关闭证据后，仅重启接收器重新引导手机。
  切换时画面会暂时断开，手机可能再次要求确认；不自动开启热点或替客户端连接。
- 同一个 `wlan0` 的热点可能替换现有 Wi-Fi，断开 SSH 和当前 CarPlay。
  Wi-Fi 客户端与 AP 同时运行的稳定性尚未验证，切换前需准备独立管理或回滚。
- 热点不自动提供互联网。蜂窝上网需要正常 SIM 和数据连接；
  iPhone → 蓝牙 PAN → comma → Tesla 的共享上网方案尚未实现。
- `99.99.99.99` 是实际公网地址，此映射只限受控热点客户端和指定端口。

如果 comma 和 Tesla 都是外部路由器的客户端，这个热点监测器不会替路由器配置
映射；需要在路由器设置精确 DNAT，并按拓扑处理 hairpin SNAT。
`comma.play` 域名尚未配置，需要客户端可见的 DNS，不能只改 comma 的 hosts。

## 安装配置

### 部署教程：电脑 → comma 3

以下适用于**首次安装**，全程驻车操作。已有安装不要直接覆盖目录，升级说明见本节末尾。
先让 comma 加入可通过 SSH 管理的 Wi-Fi，暂时不要切换热点。

准备：

- 可登录 `comma@<comma-IP>` 的 SSH 密钥，自行核对首次连接的主机指纹。
- comma 上可用的 `sudo`、Python 3、NetworkManager、BlueZ 和
  `iptables-legacy`；蓝牙初始化还依赖设备现有的系统硬件程序。
  这是 comma 3 的部署方式，不是任意 Linux 主机的通用安装器。
- **ARM64 运行包** `commaplay-prototype.tar.gz`，包含 Java 21、接收器依赖、
  已构建网页和独立 Python 依赖。当前本地打包产物位于
  `.runtime/commaplay-prototype.tar.gz`；GitHub 源码 ZIP **不是运行包**。
  下文开发构建命令也不会自动下载 ARM64 Java 或生成这个完整运行包。
- 自己合法持有的 MFi 身份，以及实际 Wi-Fi SSID、密码、频道。
  没有身份也可先用诊断模式验证部署，但不能接收真实 CarPlay。

**1. 在电脑上传运行包。** 将占位 IP 换成实际地址，文件名按下载位置调整：

```sh
scp commaplay-prototype.tar.gz comma@<comma-IP>:/data/commaplay-prototype.tar.gz
ssh comma@<comma-IP>
```

**2. 以下命令在 comma 的 SSH 会话执行。** 只在目标目录不存在时解压，
避免覆盖已保存的身份和设置；不写系统只读分区：

```sh
test ! -e /data/commaplay && mkdir /data/commaplay &&
  tar -xzf /data/commaplay-prototype.tar.gz -C /data/commaplay
```

如果提示目录已存在，停止首次安装流程，不要删除旧目录重来。
确认解压成功后，检查运行时并先启动诊断模式：

```sh
/data/commaplay/runtime/bin/java -version
mkdir -p /data/commaplay/state /data/commaplay/identity
chmod 700 /data/commaplay/state /data/commaplay/identity
printf 'diagnostics\n' > /data/commaplay/mode
sudo /data/commaplay/deploy/start.sh
sudo systemctl status commaplay.service commaplay-hotspot.service commaplay-network.service --no-pager
curl -fsS http://127.0.0.1:8080/api/status
```

Java 应为 21，两个模块服务应处于 active。电脑浏览器打开
`http://<comma-IP>:8080/`，确认能显示明确标记的测试画面；
这一步不代表 iPhone 已连接。热点关闭时 `/api/hotspot` 显示映射关闭是正常的。
若服务失败，先查日志，不要直接进入后面的真实模式或安装自启。

**3. 配置真实 CarPlay。** 在 comma 创建私有目录：

```sh
mkdir -p /data/commaplay/identity/offline-mfi
chmod 700 /data/commaplay/identity/offline-mfi
```

在电脑将自己的 `identity.pk8`、`certificate.p7b` 上传到该目录：

```sh
scp identity.pk8 certificate.p7b comma@<comma-IP>:/data/commaplay/identity/offline-mfi/
```

回到 comma，设置权限，用编辑器创建 `receiver.args`，按下一节的示例填写
真实无线参数；不要把密码直接写入 shell 命令历史：

```sh
chmod 600 /data/commaplay/identity/offline-mfi/identity.pk8 \
  /data/commaplay/identity/offline-mfi/certificate.p7b
touch /data/commaplay/receiver.args
chmod 600 /data/commaplay/receiver.args
```

驻车打开 `/debug.html`，扫描、核对配对码并选择自己的 iPhone。
然后在 comma 切换模式并重启**接收器模块**：

```sh
printf 'carplay\n' > /data/commaplay/mode
sudo systemctl restart commaplay.service
python3 /data/commaplay/deploy/check-iphone.py
```

预检查不能证明 MFi 认证成功。完成手机授权后，确认主页面有真实画面、
触控正常，播放音乐时 Debug 音频包持续增长且浏览器实际有声音。
若配对按钮被锁定，按「蓝牙与驻车限制」检查状态来源，不要绕过安全检查。

**4. 验收后安装自启。**

```sh
sudo python3 /data/commaplay/deploy/install-autostart.py
```

在可恢复 SSH 的驻车环境重启设备，确认 openpilot 正常启动、
CommaPlay 服务恢复，以及 `/api/status` 可访问。不要用
`systemctl enable` 代替此步骤：`/run` 中的服务注册会在重启后消失，
由开机入口重新建立。

**已有安装升级：** 驻车时先备份 `/data/commaplay`（含私有配置，备份也要保护），
核对新包内容后停止 `commaplay.service`、`commaplay-bluetooth-web.service`、
`commaplay-hotspot.service` 和 `commaplay-network.service`。仅更新包内运行文件，保留 `mode`、
`receiver.args`、`state/`、`identity/`；不要把备份放进发布包。
再执行 `deploy/start.sh` 并按上述步骤验收。升级失败时恢复原运行文件，
不要抹掉手机配对或身份来代替回滚；此项目尚未提供一键升级安装器。

### 运行布局

```text
/data/commaplay/
  server/lib/       JVM 接收器及依赖
  runtime/          ARM64 Java 21 与原始许可证目录
  web/dist/         主页面、Debug、浏览器能力检测页
  native/           蓝牙桥、网页配对 broker、热点监测器
  deps/             独立 Python 依赖
  deploy/           启动脚本、systemd 单元、开机入口安装器
  testdata/         合成 H.264 测试片段
  mode              carplay 或 diagnostics
  receiver.args     私有启动参数，每行一个参数或值
  state/            私有接收器身份、配对记录等状态
  identity/         私有 MFi 身份
```

生产运行不需要 Node、Gradle、ffmpeg、Electron 或桌面环境。
网页端口为 **8080**，CarPlay 端口为 **17000**，避免占用现有 7000。
接收器和网页蓝牙 broker 以 `comma` 运行；热点规则监测服务以受限 root 权限运行。
接收器配置 Java 堆 256 MiB、低优先级和 systemd 资源限制；
内核支持情况及实际车辆负载仍需观察。

### MFi 与无线参数

真实 CarPlay 必须由设备所有者提供合法、有效且匹配的认证材料：

```text
/data/commaplay/identity/offline-mfi/identity.pk8
/data/commaplay/identity/offline-mfi/certificate.p7b
```

私钥格式为 PKCS#8 DER P-256；身份目录权限 700，文件权限 600。
文件存在不等于认证有效。项目发布包不包含认证材料；
第三方 ZIP 附带材料也不代表获得使用或再分发授权。
SSH 密钥、Apple ID 密码不是 MFi 身份。

`receiver.args` 是参数文件，**不是 shell 脚本**。示例：

```text
--wifi-ssid
YOUR_NETWORK
--wifi-passphrase
YOUR_PASSWORD
--wifi-channel
36
--bt-address
AA:BB:CC:DD:EE:FF
```

填写实际网络和自己的手机地址。网页选择手机只更新 Bluetooth 目标，
保留 Wi-Fi 配置，下次接收器启动生效。
`mode` 为 `carplay` 时运行真实接收器；`diagnostics` 只显示明确标记的合成测试图，
不启动真实 CarPlay、不加载 MFi，不能用于判断手机连接成功。

### 蓝牙与驻车限制

Qualcomm 蓝牙需要固件、电源和 UART 初始化，单独启动 BlueZ 不够。
启动助手复用系统硬件初始化程序；若其他服务已管理 radio，不接管或停止它。
不设置 Carrot 的 `/data/bluetooth/ENABLED`，不留下无限期可配对窗口。

网页配对使用应用范围的 BlueZ agent，必须人工核对配对码。
扫描上限 30 秒，确认提示 60 秒，配对 90 秒。
写操作要求来自 `/dev/shm/carrot-bluetooth/status.json` 的新鲜驻车且巡航关闭证据；
缺失或超过 2 秒则锁定，不能用伪造固定状态绕过。

无线交接仅在 iPhone 请求 `disableBluetooth` 且 Wi-Fi iAP2 认证就绪后
关闭本模块的 RFCOMM 引导连接，不关闭整个蓝牙控制器。
接收端保留完整双向音频格式声明；关闭输入格式曾导致实机连音乐路由也不建立。
协议声明不会绕过浏览器麦克风授权或 HTTP 安全限制。

## 启动、停止与开机自启

手动只需要一个入口，重复执行不会重启已运行的接收器：

```sh
sudo /data/commaplay/deploy/start.sh
```

该入口初始化蓝牙，注册并启动接收器、网页配对 broker、热点与网络监测器。
系统分区保持只读：源文件在 `/data`，运行单元注册到 `/run/systemd/system`。

启动时自动读取活动 Wi-Fi 配置；运行期间每轮检测后等待 2 秒。
热点开启时，iPhone 和浏览器应接入 comma 热点；热点关闭时，两者应与 comma
接入同一可互通 Wi-Fi。监测器不修改 NetworkManager、不覆盖 `receiver.args`
或 `state/config.json`，仅生成优先级更高的私有运行参数
`/run/commaplay-network/receiver.args`（root/comma，640）。
需 root 读取 NetworkManager 密码及驻车状态；日志不输出密码。
开放网络、WPA2-PSK、WPA3-SAE 可识别；企业认证或无法读取密码时保留上次配置，
不会猜测凭据。初次启动检测失败则使用原配置，应查监测日志核对。

初次安装开机入口或撤销入口：

```sh
sudo python3 /data/commaplay/deploy/install-autostart.py
sudo python3 /data/commaplay/deploy/install-autostart.py --remove
```

安装器在 `/data/continue.sh` 的 openpilot 启动之前插入唯一标记块，
首次备份原文件并保留权限；拒绝无法辨认或被修改的块。
后台启动不会等待手机连接，不阻塞 openpilot；不要重复添加开机脚本。
当前设备已经安装入口，无需每次重启后 SSH 手动启动。
不同网络、断电和车辆负载条件仍需驻车验证。

```sh
sudo systemctl status commaplay.service commaplay-hotspot.service --no-pager
sudo journalctl -u commaplay.service -n 40 --no-pager
sudo journalctl -u commaplay-hotspot.service -n 30 --no-pager
sudo journalctl -u commaplay-network.service -n 30 --no-pager
cat /run/commaplay-hotspot/status.json

# 停止接收器及关联的网页配对 broker；热点监测器独立运行
sudo systemctl stop commaplay.service
# 停止热点监测并撤销其地址映射
sudo systemctl stop commaplay-hotspot.service
# 停止网络监测；需要一起停止以便维护运行文件
sudo systemctl stop commaplay-network.service
```

## 排查问题

| 现象 | 检查方向 |
|---|---|
| 自动进入 Debug | 查看转入原因；接收器就绪、手机会话和首帧是不同阶段 |
| 蓝牙已连接但没有画面 | 查看 MFi、Wi-Fi 引导及接收器日志；配对不等于 CarPlay 握手 |
| 音乐仍从 iPhone 发出 | Debug 查看音频包是否增长；无包时检查手机实际播放与输出选择 |
| 收到音频但浏览器无声 | 点按页面触发授权，检查音量、浏览器编码能力和错误信息 |
| Tesla 入口打不开 | 确认车机连接的是 comma 热点、映射已就绪，而不是外部路由器 Wi-Fi |
| 改热点后手机断连 | 查看网络监测日志、驻车状态及 `ss -lnt` 的 17000 监听地址；等待重新引导 |
| 设置操作被锁定 | 检查真实驻车/巡航状态及证据时效，不要关闭安全检查 |
| 手机卡没有数据连接 | 先确认 SIM 已识别和运营商注册，再检查 APN；APN 不能修复 `SIM absent` |

只读诊断入口：

```text
/api/status       会话、接收器及真实音频包状态
/api/hotspot      热点映射状态；监测过期时返回不可用
/api/readiness    蓝牙、身份文件与无线配置预检查
/probe.html      浏览器能力检测
```

`audio.packetsReceived` 表示接收器实际收到的包，
`lastPacketAgeMs` 表示最后一包距今时间，`streams` 表示活动编码。
`resourceOwner` 是手机报告的音频资源归属，**不是输出设备列表，也不是可听见声音的证明**。

## 开发与测试

需要 Java 21、Node/npm、Python 3；媒体测试需要 ffmpeg/ffprobe 和 Playwright Chromium。

```sh
./gradlew :server:test :server:installDist --no-daemon
cd web
npm ci
npm run build
npx playwright install chromium
npm test
npm run test:mux
npm run test:audio
TEST_NO_AUTH=1 npm run test:debug
npm run test:debug
cd ..

python3 tests/linux-platform.test.py
python3 tests/iphone-readiness.test.py
python3 tests/autostart.test.py
python3 tests/hotspot-nat.test.py
python3 tests/network-sync.test.py
python3 -m pip install --target .runtime/pydeps -r deploy/requirements.txt
PYTHONPATH="$PWD/.runtime/pydeps" python3 tests/web-bluetooth.test.py

# 仅在隔离网络命名空间验证真实 DNAT，不改宿主网络
sudo unshare --net python3 tests/hotspot-nat-network.test.py
```

测试覆盖浏览器输入、媒体解码与音量、自动播放限制、单控制端、同源检查、
网页配对安全限制及热点开关/地址变化/清理。通过测试不替代 Tesla 实车验收。
Python 生产依赖放在独立 `deps/`，不修改 openpilot 或系统 Python 环境。

## 安全、来源与许可证

部署入口默认使用 `--no-browser-auth`，可信 LAN 内其他设备也能访问或控制。
仍保留同源写入检查、单控制端和驻车设置限制，但这些不等于登录认证。
独立启动 JVM 默认仍支持可选 token 模式；HTTP token 也不能替代传输加密。
请隔离网络，禁止 WAN 端口映射。

不要提交或发布 `state/`、`identity/`、`receiver.args`、Wi-Fi 密码、
SSH 凭据、配对记录或未脱敏日志。发布包只包含明确选择的运行文件与许可证；
再分发前必须满足完整对应源码及运行依赖的许可证义务。

| 项目 | 采用内容 |
|---|---|
| [PlayPort](https://github.com/youcci/playport) | JVM 接收器与浏览器基础，包含 DiPlay/xcertplay 协议来源 |
| [LinuxPlay](https://github.com/Roylyl/LinuxPlay) | Linux 蓝牙桥及相关测试 |
| [map2tesla](https://github.com/jixiexiaoge/map2tesla) | 浏览器 fMP4 布局思路；未复制 Android VPN |
| [DashPlay](https://github.com/yizhixiaoheigou/DashPlay) | 滑动终点与捕获处理参考、蓝牙身份一致性对比 |
| [NIOPlay](https://github.com/kissggj123/NIOPlay) | 完整双向音频声明参考；未复制原生播放引擎 |
| [wheelplay](https://github.com/fython/wheelplay) | 条件保护的蓝牙到 Wi-Fi iAP2 交接 |
| Carrot | 应用范围的 BlueZ 网页配对机制，保留 MIT 通知 |

CommaPlay 原始贡献：**Copyright (c) 2026 机械小鸽**。
项目遵守 GNU GPLv3，保留上游版权及依赖许可证；
详见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[licenses/](licenses/) 和
[README.upstream.md](README.upstream.md)。
本项目不是独立重写的协议实现，不包含可再分发的 MFi 认证身份。
CarPlay、iPhone、Tesla 为第三方商标；项目不隶属于 Apple、Tesla 或 comma.ai。
