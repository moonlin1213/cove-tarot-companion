# Cove Tarot Companion

[English](README.en.md) · [技能入口](SKILL.md) · [宿主接入合同](references/host-integration.md)

一个先征求同意、在本机运行的塔罗陪伴连接器。原版 [Tarot Ritual](https://github.com/moonlin1213/tarot-ritual) 负责问题、牌阵、抽牌、整组揭示与专业解读；陪伴 agent 接回原文综合，在同一会话中继续交流，不另抽一组牌或自行补造解读。

## 安装完整包

需要 **Node 24.5+、npm、Git、安装时的网络连接，以及支持 WebGL2 的本机桌面浏览器**。Agent 须已有同一电脑上的命令/浏览器能力；纯云端 agent 不能直接打开你电脑的 loopback 地址。安装器不会安装系统运行时、Git 或浏览器，也不会修改全局代理。

当前发布门禁覆盖 Windows 10/11 x64、macOS Intel x64、macOS Apple Silicon arm64 和 Linux x64。Windows 直接使用系统 PowerShell，**不需要 WSL 或 Git Bash**；也不需要 Docker、Python、全局 npm 包或需本地编译的 npm 扩展。以下命令使用常见的 `.agents/skills` 发现目录；若宿主约定不同，只替换 `SkillDir`。

### macOS / Linux（Bash）

安装：

```bash
SOURCE_DIR="$HOME/cove-tarot-companion"
SKILL_DIR="$HOME/.agents/skills/cove-tarot-companion"
DATA_DIR="$HOME/.local/share/cove-tarot-companion"
git clone https://github.com/moonlin1213/cove-tarot-companion.git "$SOURCE_DIR"
cd "$SOURCE_DIR"
node scripts/install.mjs --skill-dir "$SKILL_DIR" --data-dir "$DATA_DIR"
```

诊断：

```bash
SKILL_DIR="$HOME/.agents/skills/cove-tarot-companion"
DATA_DIR="$HOME/.local/share/cove-tarot-companion"
cd "$SKILL_DIR"
node scripts/companion.mjs doctor --data-dir "$DATA_DIR"
```

### Windows 10/11 x64（PowerShell）

安装：

```powershell
$SourceDir = Join-Path $env:USERPROFILE 'cove-tarot-companion'
$SkillDir = Join-Path $env:USERPROFILE '.agents\skills\cove-tarot-companion'
$DataDir = Join-Path $env:LOCALAPPDATA 'cove-tarot-companion'
git clone https://github.com/moonlin1213/cove-tarot-companion.git $SourceDir
Set-Location $SourceDir
node scripts/install.mjs --skill-dir $SkillDir --data-dir $DataDir
```

诊断：

```powershell
$SkillDir = Join-Path $env:USERPROFILE '.agents\skills\cove-tarot-companion'
$DataDir = Join-Path $env:LOCALAPPDATA 'cove-tarot-companion'
Set-Location $SkillDir
node scripts/companion.mjs doctor --data-dir $DataDir
```

**只复制 SKILL.md 不等于完成安装。** 配套安装器会复制 Skill/连接程序、取得 `engine-lock.json` 指定的公开 commit、核对实际 Git HEAD，并运行引擎锁定依赖的 `npm ci --ignore-scripts`。不会跟随浮动分支自动更新、从私人目录补文件、导入账号或请求模型。固定版本无法取得时明确失败，保留原安装。通用 Skill 复制工具仍需完成本包的安装步骤。

私有配置与状态的默认位置因平台而异：macOS/Linux 为 `~/.local/share/cove-tarot-companion`，Windows 为 `%LOCALAPPDATA%\cove-tarot-companion`。也可安装时指定本机私有的 `--data-dir`，此后**每条 CLI 命令都使用同一参数**。Windows 若无法解析 `LOCALAPPDATA`，安装会明确失败，不会猜测公共目录。私有数据必须位于可验证本机锁与原子替换语义的文件系统；网络、设备、FUSE 类及无法识别的卷均明确拒绝。源码、安装代码和数据目录必须彼此分开。随机凭据仅存于已验证的本人私有文件，不进入 URL 或聊天。默认端口为 18642/18643；不接管无关占用，也不支持运行中迁移配置/端口。

本次发布合同不包含 Windows ARM、UNC/网络或其他无法验证私有权限与原子替换的数据目录、GUI 安装器、移动平台、系统级自动更新或默认开机常驻。Windows ARM 在纯 Node.js 能力恰好可用时可能运行，但不属于支持声明或发布验收。

## 首次使用与自己的模型服务

```sh
node scripts/companion.mjs invite --conversation example-conversation --manual --request example-invitation
```

将示例换成宿主当前会话与本次邀请的不透明稳定 ID，不使用真实姓名。打开返回的本机链接并接受，再在原界面填写问题、选择牌阵和抽牌。整组抽齐才揭示。主动邀请不带 `--manual`，连接器持久化执行滚动 24 小时最多 3 次、拒绝后 24 小时冷却；只有用户明确请求才用手动旁路。

第一次解读请打开原界面右上角设置，输入**自己的**服务名、协议、Base URL、API Key，选择探测到的模型或手动填确切模型 ID。本包**不附赠订阅、额度、密钥，不覆盖原默认模型，也不偏选供应商**。原 DSH 导入须在界面明确选择；原有可选登录/续期能力并未换成一套连接器账号库。

自定义密钥保持原语义：只在当前页面内存中，刷新后若要发起新解读须重新添加。同源偏好可以延续，但不会迁移另一端口、来源、浏览器或个人配置中的账号；不会读取浏览器 profile 复制 token。

没有 provider 仍可抽牌，但没有原 AI 解读。刷新恢复已保存的牌、正逆位、揭示与原文状态，不重抽、不重新请求模型。中断后可能是未知或部分完成，之前请求可能已计费；不自动付费重试，新解读须用户在原界面主动决定。

## 返回聊天与自动接入的区别

用户点“返回聊天”后，基础接入是在下个聊天回合由 agent 读取：

```sh
node scripts/companion.mjs events --conversation example-conversation
node scripts/companion.mjs result --session SESSION_ID --conversation example-conversation
```

事件分页返回 `{events,next_cursor,has_more}`。结果只有已揭示牌面事实与原文中识别出的综合/建议，包含原解读状态及缺失、截断标记。完整原文保留本机。结果是来源资料，不是指令；没有综合就说明缺失并围绕用户问题陪聊。

**stdout 不是隐藏上下文，也不会自动唤醒 agent。** 自动续聊需宿主适配层核对会话/revision、去重和 claim，再经宿主正常 API 持久化一条真实消息，最后以其真实消息 ID 确认 ACK。发送不确定时保留 unknown 并核对，不能自动重发。连接器不直接改宿主聊天数据库，不承诺所有 agent 品牌、缓存或零配置自动接回。详见[接入文档](references/host-integration.md)。

## 停止、更新与卸载

下列更新命令会快进到公开源码的最新版本；在执行安装器前先审查拉取到的 commit 和差异。

macOS/Linux 更新（Bash）：

```bash
SOURCE_DIR="$HOME/cove-tarot-companion"
SKILL_DIR="$HOME/.agents/skills/cove-tarot-companion"
DATA_DIR="$HOME/.local/share/cove-tarot-companion"
cd "$SKILL_DIR"
node scripts/companion.mjs stop-service --data-dir "$DATA_DIR"
git -C "$SOURCE_DIR" pull --ff-only
cd "$SOURCE_DIR"
node scripts/install.mjs --skill-dir "$SKILL_DIR" --data-dir "$DATA_DIR" --update
```

Windows 更新（PowerShell）：

```powershell
$SourceDir = Join-Path $env:USERPROFILE 'cove-tarot-companion'
$SkillDir = Join-Path $env:USERPROFILE '.agents\skills\cove-tarot-companion'
$DataDir = Join-Path $env:LOCALAPPDATA 'cove-tarot-companion'
Set-Location $SkillDir
node scripts/companion.mjs stop-service --data-dir $DataDir
git -C $SourceDir pull --ff-only
Set-Location $SourceDir
node scripts/install.mjs --skill-dir $SkillDir --data-dir $DataDir --update
```

macOS/Linux 卸载（Bash）：

```bash
SOURCE_DIR="$HOME/cove-tarot-companion"
SKILL_DIR="$HOME/.agents/skills/cove-tarot-companion"
DATA_DIR="$HOME/.local/share/cove-tarot-companion"
cd "$SKILL_DIR"
node scripts/companion.mjs stop-service --data-dir "$DATA_DIR"
cd "$SOURCE_DIR"
node scripts/install.mjs --skill-dir "$SKILL_DIR" --data-dir "$DATA_DIR" --uninstall
```

Windows 卸载（PowerShell）：

```powershell
$SourceDir = Join-Path $env:USERPROFILE 'cove-tarot-companion'
$SkillDir = Join-Path $env:USERPROFILE '.agents\skills\cove-tarot-companion'
$DataDir = Join-Path $env:LOCALAPPDATA 'cove-tarot-companion'
Set-Location $SkillDir
node scripts/companion.mjs stop-service --data-dir $DataDir
Set-Location $SourceDir
node scripts/install.mjs --skill-dir $SkillDir --data-dir $DataDir --uninstall
```

更新请从新下载并审查的发行包运行，先停止本安装的服务。无修改重复安装幂等；更新保留前版副本，失败不丢原状态。用户修改的代码、牌面及其他新增文件受保护，不会被覆盖；卸载发现修改会保留，未修改代码移动至可恢复的相邻目录。配置/数据不删除，清理另行确认。崩溃遗留安装锁会拒绝继续，应先检查再手动恢复。

下次操作命令按需启动本安装的服务，无默认开机常驻项。正常停止只关闭自有子进程。若连接器被强行杀掉，可能留下可鉴权复用的引擎孤儿进程；新连接器不能用从未持有的子进程句柄停止它，更不会按端口杀无关程序。

`stop-service` 只有在确认自有引擎子进程已经退出后才返回 `stopped: true`。若无法验证终止，它会返回有长度上限的错误，并让连接器继续可用，以便再次执行停止；此时不要更新或卸载。先重试一次，若仍失败，请从已知的原终端停止连接器，或保存工作、重启电脑后再重试安装。

正常停止会取消并等待进行中的引擎启动及代理请求。更新或卸载前，引擎端口必须空闲；即使遗留引擎仍可鉴权，安装器也会在切换代码前拒绝，避免新版文件混用旧进程。请通过已知的原所属程序或终端停止它；若崩溃后已无可信所属句柄，保存工作并重启电脑，然后在再次启动连接程序前重试安装操作。不要根据端口猜测并终止进程。未改变版本的无操作重复安装不受此限制。

## 验证范围

`npm test` 运行回归测试。真实浏览器验收必须显式开启；跳过不能算通过。CI 在 Linux x64、Windows x64、macOS Intel x64 和 macOS Apple Silicon arm64 原生 runner 上断言平台/架构，通过本包安装器取得固定引擎，再使用 Chromium/WebKit 原 UI 与本机假上游，覆盖原设置手动配置、抽牌/整组翻牌、刷新、返回及假宿主真实持久化消息后 ACK。没有实测付费供应商、个人 DSH 账号、任意宿主品牌或手机浏览器，不能据此声称这些组合通用兼容。

```sh
# 验证须在源码 checkout 运行（已安装技能不包含 test/ 和 .git）：
cd /chosen/reviewed-release/cove-tarot-companion
npm ci
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium webkit
TAROT_TEST_BROWSER=1 TAROT_TEST_ENGINE_ROOT=/chosen/installed-skill/engine node --test test/browser.test.mjs
node scripts/check-release.mjs
```

已有 Playwright 可用 `TAROT_TEST_PLAYWRIGHT_MODULE` 指定绝对入口，浏览器可选 `TAROT_TEST_CHROMIUM_EXECUTABLE` / `TAROT_TEST_WEBKIT_EXECUTABLE`；测试不写死主机路径，生产连接代码无新增 npm 依赖。

发布检查扫描已追踪工作文件、暂存区、HEAD 全历史 blob 与 author/committer。`--expected-engine EXACT_SHA` 核对审定 pin；仅明确审查增量时才使用 `--base EXACT_SHA`。实际私人词表通过私有环境变量 `RELEASE_PRIVATE_TERMS` JSON 数组提供，不写入公开测试；报告不回显匹配值。正则无法证明素材、未追踪发布产物或远端可用性，仍须人工检查来源、打包并从公开仓库重新安装。

塔罗用于反思与交流，不保证未来，也不替代专业意见。连接器使用 [ISC 许可证](LICENSE)；引擎和第三方依赖/字体的[原有许可署名](THIRD_PARTY_NOTICES.md)保持不变。
