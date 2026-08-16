# LingoLens

[English](README.md) | [简体中文](README.zh-CN.md)

翻译普通网页，并把每个 YouTube 视频变成一份可以深入学习的资料。LingoLens 把页面内划词翻译与侧边栏中的整页双语阅读、字幕、AI 概览、内容讲解和时间戳笔记组合在一起。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过 AI 概览、章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、概览或笔记中的时间戳，快速跳转到对应位置。
- 保存自动润色的时间戳笔记，方便之后复习。
- 在页面内翻译选中的英文，或在普通网页正文的英文下方插入简体中文。
- 使用自己的 API Key，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

LingoLens 是一个需要自行提供 API Key 的本地项目，可直接使用本次生成的目录或 ZIP 安装。目前没有上架 Chrome 应用商店，不赠送 API 额度，也没有开发者运营的服务器。

## 项目来源

LingoLens 是基于 zarazhangrui 的 [YouTube Digest](https://github.com/zarazhangrui/youtube-digest) 改进并独立维护的项目；上游项目采用 MIT License。LingoLens 保留了原项目的 YouTube 学习流程，并增加了普通网页划词翻译、整页双语翻译、带 Deepgram 回退的实时双语字幕、统一的 DeepSeek Flash/Pro 模型设置，以及相关界面和可靠性改进。LingoLens 并非上游项目的官方版本。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把本次生成的 LingoLens 项目目录，或解压后的 ZIP，放到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/lingolens`，或 Windows 上的 `%USERPROFILE%\Documents\lingolens`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。

你的 Agent 应该帮你：

1. 先询问你想把生成的项目目录或解压后的 ZIP 长期保存在哪里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/lingolens`，或 Windows 上的 `%USERPROFILE%\Documents\lingolens`。
2. 打开下方 Supadata 和 DeepSeek 官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个带字幕的 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 LingoLens 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 找到本次生成的 `lingolens-v1.3.2.zip`，也可以直接使用 `lingolens-v1.3.2` 项目目录。
2. 如果使用 ZIP，请选择一个长期保留的文件夹并解压。可选建议是 macOS 或 Linux 上的 `~/Documents/lingolens`，或 Windows 上的 `%USERPROFILE%\Documents\lingolens`。你也可以使用其他文件夹。
3. 在 Chrome 地址栏打开 `chrome://extensions`。
4. 打开右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
7. 如果需要，可以在 Chrome 扩展菜单中固定 LingoLens。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 LingoLens 并点击“重新加载”，然后刷新已经打开的 YouTube 页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API Key

LingoLens 使用你自己的服务 Key：

1. **Supadata API Key**，用于获取 YouTube 字幕。
2. **DeepSeek API Key**，用于网页与字幕翻译、生成概览、讲解内容和自动润色笔记。
3. 可选的 **Deepgram API Key**，用于网页没有完整字幕轨时的实时听写。

### 获取 Supadata API Key

1. 打开 Supadata 官方[注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的新手引导。
3. Supadata 会在新手引导过程中自动生成 API Key。
4. 之后可以随时打开 [Supadata 控制台](https://dash.supadata.ai/)查找或管理 Key。
5. 复制 Key，并粘贴到 LingoLens 设置中的 **Supadata API key**。

如果页面流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 DeepSeek API Key

1. 打开 DeepSeek 官方 [API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 按照提示登录，或创建 DeepSeek 开放平台账号。
3. 点击 **Create new API key**，填写容易识别的名称，例如 `LingoLens`，然后创建 Key。
4. 立即复制 Key。完整 Key 可能只会显示一次。
5. 把 Key 粘贴到 LingoLens 设置中的 **DeepSeek API key**。
6. 如果 DeepSeek 提示余额不足，请在 DeepSeek 开放平台账号中充值后再试。

当前账号和接口说明请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 LingoLens 卡片中打开扩展选项。Key 只能粘贴到这些设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

发布版本使用 DeepSeek，并允许选择 V4 Flash 或 V4 Pro：

```text
Base URL: https://api.deepseek.com
Models: deepseek-v4-flash, deepseek-v4-pro
```

LingoLens 会让所有 DeepSeek 请求使用非思考模式，以获得更快、更稳定的交互。全部功能共用一个 DeepSeek Key，并使用设置中选择的 Flash 或 Pro 模型。如果想使用其他服务或模型系列，请在设置中复制安全的自定义 prompt，让编程 Agent 修改你自己的本地副本。不要把任何 API Key 放进 prompt 或对话。

API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 使用 LingoLens

### 翻译普通网页

1. 打开普通 HTTP 或 HTTPS 网页，用鼠标或键盘选中英文，选区附近会显示 **译** 按钮；单纯选中文字不会发送 API 请求。
2. 点击 **译** 后才会把当前选区发送给 DeepSeek。页面内译文卡支持复制结果、失败重试和关闭。
3. 打开扩展侧边栏，点击 **Translate page**，在可读的英文标题、段落、列表、引用、图注和表格单元格下方插入简体中文；可随时停止或移除。

整页翻译会保留上下文中的 `a.shape` 等行内代码标识符、函数名以及键盘或示例输出文字。预格式化代码块会被排除，不会发送翻译。

在 YouTube 页面中，网页翻译卡默认折叠，让 Digest 保持为主界面。浏览器内部页面、Chrome 应用商店、PDF 阅读器内容、跨域 iframe、Canvas 和图片文字不受支持。

### 学习 YouTube 视频

1. 打开一个有字幕的普通 YouTube 视频页面。
2. 点击 LingoLens 扩展图标，打开侧边栏。
3. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。
4. 打开 **Overview**，查看 AI 生成的章节和重点引用。
5. 选中字幕，获取 AI 内容讲解。
6. 从播放器或重点引用中保存笔记，之后可以在 **Notes** 中查看。

## 当前支持范围

### 任意网页视频的实时双语字幕

1.2 版本为普通 HTTP 和 HTTPS 标签页增加了英语到简体中文的字幕模式。
打开包含 HTML5 视频的页面，在侧栏中点击“Start subtitles”即可开始。

- 如果页面提供完整的时间轴字幕，扩展会先读取全文，建立主题和术语上下文，
  优先翻译当前位置之后三分钟的内容，再在后台完成其余字幕。
- YouTube 有原生字幕时仍优先通过 Supadata 获取完整字幕。
- 如果没有完整字幕，扩展会捕获用户选择的标签页音频，直接发送给 Deepgram
  Nova-3 实时听写，再把定稿英文连同上下文发送给 DeepSeek 翻译为简体中文。
- 视频浮层和侧栏使用同一份中英分段。会话保存在本地，可导出为 SRT、VTT
  或 Markdown。
- 页面浮层默认采用紧凑尺寸，并可拖到屏幕中的其他位置。把鼠标移到浮层上或用
  键盘聚焦后，可以调节字号、切换窄/标准/宽三档、隐藏字幕、停止会话或重置布局。
  显示偏好会在当前 Chrome profile 中跨网站复用。

实时回退需要你自己的 Deepgram API 密钥，并且只能由用户点击按钮后开始。
Chrome 内部页面、受保护的 DRM 媒体，以及部分跨域全屏播放器中的字幕浮层
不受支持；浮层不可用时仍可在侧栏查看字幕历史。

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面。
- Supadata 能够返回的原生字幕。LingoLens 会优先请求英文字幕，也可能显示其他可用的原生语言。
- 原文、简体中文和双语对照字幕。
- AI 概览、选中文本讲解、翻译和自动润色笔记。
- 本地笔记，以及最近字幕、概览和翻译的本地缓存。
- 发布版本的全部 AI 功能可使用 DeepSeek V4 Flash 或 V4 Pro。其他服务需要修改本地代码。

YouTube 摘要功能仍要求标准且可访问的视频页面以及原生字幕。实时字幕回退可处理
许多直播和没有原生字幕的视频，但私密、受保护或受访问限制的媒体可能阻止音频
捕获或字幕浮层。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

LingoLens 强制使用 Supadata 的 `mode=native`，不会在没有原生字幕时请求 AI 生成转录，也不会在本地转录音频。

## Supadata 免费额度和请求成本

截至 2026 年 8 月 9 日，[Supadata 价格页面](https://supadata.ai/pricing)显示免费版每月提供 **100 credits**，不需要信用卡，未使用的额度不会结转。价格可能变化，使用前请查看最新页面。

[Supadata 字幕接口文档](https://docs.supadata.ai/get-transcript)说明了不同模式的计费方式：

- 获取一次原生字幕消耗 **1 credit**，与视频时长无关。
- AI 生成字幕每分钟消耗 **2 credits**。LingoLens 不会使用这条路径，因为它强制使用 `mode=native`。
- 如果没有可用原生字幕并返回 HTTP `206`，仍会消耗 **1 credit**。

按照当前只获取原生字幕的方式，如果每次请求都成功，免费版每月大约可以查询 100 个视频。重试和没有字幕的查询也会消耗额度，所以实际成功数量可能更少。

DeepSeek 的额度与 Supadata 分开计算。DeepSeek 可能有自己的免费额度、限速或费用。LingoLens 不收款，也不转售 API 服务。建议为两个账号设置消费上限并定期查看用量。下方估算说明了当前 DeepSeek 翻译成本。

## DeepSeek V4 Flash 翻译成本估算

截至 2026 年 8 月 10 日，DeepSeek 官方[价格页面](https://api-docs.deepseek.com/quick_start/pricing/)列出的每 100 万 token 价格是：

- 缓存命中输入：**¥0.02**。
- 缓存未命中输入：**¥1**。
- 输出：**¥2**。

DeepSeek 说明这些价格可能很快上调，因此使用此估算前必须查看当前价格页面。官方 [token 用量指南](https://api-docs.deepseek.com/quick_start/token_usage/)估算每个英文字符约为 0.3 token，每个中文字符约为 0.6 token。[上下文缓存指南](https://api-docs.deepseek.com/guides/kv_cache/)说明了重复前缀使用的自动尽力而为磁盘缓存。

一个实测的 20 分钟英文演讲包含 **2,935 个英文口语词**和 15,433 个字幕字符。按 LingoLens 当前的分组方式，它会变成 128 个语义分段，以每次 3 段的方式发出 43 次请求。算上重复 prompt 和 JSON 后，渲染后的输入约为 108,528 个英文字符，按官方每个英文字符 0.3 token 的经验值，即**约 32,600 个输入 token**。按每个中文字符 0.6 token 的经验值，再加上 JSON 和 ID 开销，中文 JSON 输出估计为 3,500 到 4,500 token。

如果所有输入都按缓存未命中计费，输入约 $0.0046，输出约 $0.0010 到 $0.0013，总计约 $0.0056 到 $0.0059。当大量重复的 system prompt 命中 DeepSeek 自动尽力而为缓存时，更现实的低值约为 $0.002 到 $0.003。完整翻译这段演讲的实用估算是 **$0.002 到 $0.006 USD，约 ¥0.02 到 ¥0.04**。

翻译是延迟按需和渐进式的。已缓存的分段会复用，只有滚动到并请求的字幕行才会发起调用。重试、服务商行为和价格变化都可能增加最终成本。

## 用编程 Agent 改造成自己的版本

这是一个个人 Remix 项目，不接受上游 Issue 或 Pull Request。如果功能出错，或者你想增加新功能，请下载或 Fork 自己的副本，再让你的编程 Agent 帮你修复、改造和个性化。

LingoLens 使用原生 HTML、CSS 和 JavaScript，没有构建步骤，很适合用编程 Agent 做个人项目。你可以尝试：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 增加生词本，保存单词、原句、解释和视频时间戳。
- 把笔记和生词导出到 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 LingoLens 项目文件夹。然后打开 LingoLens 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

LingoLens 会直接从扩展向服务商发送请求：

1. 把标准化的 YouTube 视频地址发送给 Supadata，用于获取原生字幕。
2. 当你使用 AI 功能时，把字幕和相关视频信息发送给 DeepSeek。
3. 翻译或讲解等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
4. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

LingoLens 没有账号系统、广告、分析统计或行为追踪。Supadata 和 DeepSeek 仍会按照各自的条款和隐私政策处理数据。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 LingoLens，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 `https://www.youtube.com/watch?...` 页面。
- 在 `chrome://extensions` 中确认 LingoLens 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新 YouTube 页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### LingoLens 提示需要设置

- 打开 **Settings**，保存 Supadata Key 和 DeepSeek Key。
- 发布版本固定使用 DeepSeek 接口，可在设置中选择 V4 Flash 或 V4 Pro。
- 如果设置提示旧的自定义服务已移除，请重新填写 DeepSeek Key。旧 AI Key 已安全清除，避免被错误用于 DeepSeek。

### 找不到字幕

- 确认视频是公开的，并且有原生字幕。
- 检查 Supadata Key、剩余额度、限速和账号状态。
- 没有字幕的查询和手动重试也可能消耗额度。

LingoLens 不会自动改用 AI 生成字幕。

### AI 请求失败

- `401` 或 `403` 通常表示 DeepSeek Key 或账号权限有问题。
- `429` 通常表示达到了 DeepSeek 服务限速或消费上限。
- 确认 Key 来自上方链接的 DeepSeek 开放平台账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 YouTube 视频。自动检查通过，不代表真实服务请求和 YouTube 交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
