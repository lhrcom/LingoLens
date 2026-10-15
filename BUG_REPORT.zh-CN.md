# DeepSeek 连接失败：调查与修复报告

调查日期：2026-10-15。检查版本：1.3.6，提交 `6ee0fa50d390c18d7fc647aa6d3380edf3545e5a`。修复包版本：1.3.7。

## 用户报告

Chrome 安装插件后，设置页测试连接出现 `Connection failed: DeepSeek 服务暂时不可用`。

## 已确认的问题

调用路径是 `options.js` → `ytdPageTranslationTestApi` → `translateSelection` → `requestWithRetry` → `requestAiCompletion` → DeepSeek。

1. 该中文提示由 `page-translation-core.js` 在收到 HTTP 5xx 时生成。`page-translation-background.js` 保留结构化状态码，却没有把状态码放入用户看到的错误消息。因此仅凭该提示无法区分 500、502、503、504，更无法确认是 DeepSeek 服务器还是中间网关返回。
2. 原版已有最多 3 次重试，等待 1、2、4 秒，但忽略 `Retry-After`，可能在服务端要求等待期间耗尽重试。
3. HTTP 402 没有余额不足的明确提示。
4. “Hello, world!” 连接测试沿用整页批量翻译的 8,192 输出 token 上限，超出该测试所需。
5. 默认 Flash 配置仍是旧名称 `deepseek-v4-flash`。官方推荐 `deepseek-flash`，但明确继续接受旧名，因此不能将旧名认定为本次 5xx 的根因。

Chrome 清单已经包含 `https://api.deepseek.com/*` 权限；共享请求也已关闭 thinking。没有证据支持为此扩大权限或改成第三方服务。

## 修复内容

- 页面翻译与连接测试的错误消息包含实际 HTTP 状态码，并提供可执行的重试或账户处理指引；不展示原始网关 HTML。
- 读取 `Retry-After` 的秒数或 HTTP 日期，与现有指数退避取较大值；每次等待最多 30 秒，仍最多重试 3 次。
- 401/403、402、400/422 不重试；402 明确提示检查账户余额。
- 取消后不再启动新请求，完成等待时清理取消监听器。
- 连接测试保留真实 JSON 翻译验证，输出上限降为 256 token。
- Flash 使用官方推荐名称，兼容旧设置并保留密钥；Pro 保持可选，不自动切换模型。
- 更新中英文说明、隐私与安全说明，历史价格估算明确标为历史信息。

## 验证

- 新增 8 项自动化测试，覆盖临时 503 恢复、持续 500/502/503/504、账户和参数错误、429 及取消、Retry-After、旧设置、Chrome 消息流程、JSON/HTML 网关响应。
- 4 项选定回归测试在原始提交上失败，在修复版本上通过。
- 全部 70 项测试通过；发布检查、凭据扫描、语法检查和 ZIP 打包通过。
- ZIP：`dist/lingolens-v1.3.7.zip`。

没有读取用户浏览器中的密钥，也没有使用真实 DeepSeek 账户发起付费请求。以上验证使用模拟 HTTP 响应和 Chrome API，尚未在用户实际 Chrome 环境中验证连接。因此，此修复解决已确认的插件端诊断、退避和兼容配置问题，不能承诺消除真实服务端或网络故障。

## 安装后验证

1. 解压 1.3.7 ZIP 到固定文件夹。打开 `chrome://extensions`，开启开发者模式。
2. 如果当前扩展加载的就是这份源码目录，点击其“重新加载”；如果使用其他目录，更新该目录的文件后重新加载，或通过“加载已解压的扩展程序”选择新目录。不同扩展 ID 的本地设置可能不共享。
3. 打开插件设置，选择 Flash，在本地设置中填写自己的 DeepSeek API Key，然后点击测试；不要把密钥写入 Issue 或聊天。
4. 刷新目标网页，再测试英文划词和整页翻译。
5. 若仍失败，记录新提示中的 HTTP 状态码。402 检查余额，401/403 检查密钥；持续 5xx 时检查代理/VPN 和 DeepSeek 服务状态。仅记录状态码、插件版本及发生时间。

## 官方参考

- [DeepSeek 错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
- [模型与价格：当前名称及旧名兼容说明](https://api-docs.deepseek.com/quick_start/pricing/)
- [Chat Completions 参数](https://api-docs.deepseek.com/api/create-chat-completion/)
