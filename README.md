# 笼卡管理 Web

纯前端 GitHub Pages 版本，目标地址：

```text
https://whoiswei114514.github.io/longka/
```

NTAG URL 参数：

```text
https://whoiswei114514.github.io/longka/?v=1&room=1-1&rack=2&cage=0001
```

- `room`：房号
- `rack`：笼架号
- `cage`：笼号
- 同时兼容短参数 `r`、`k`、`c`

笼卡数据仅保存在当前浏览器 Cookie 中。首次打开时，网页会在本机无感生成一个不可导出的 HKDF 根密钥并保存到 IndexedDB；后续自动使用根密钥和 Cookie 中的随机盐派生 AES-256-GCM 主密钥。Cookie 中只有盐值、随机 IV 和密文分片，不保存密钥或明文笼卡数据。根密钥不能被网页代码导出，照片只做本次预览，不写入 Cookie。

清除该站点的 Cookie 或 IndexedDB 会使本机数据无法恢复。旧版密码加密存储不会要求输入密码，升级后会自动初始化为新版本机密钥存储。

`config.js` 中的 `mimoApiKey` 当前为空，网页不会调用 Mimo API。

网页内置 PP-OCRv6 small 检测与识别 ONNX 模型，通过 ONNX Runtime Web 在客户端本地运行。模型首次使用时从本站下载并由浏览器缓存，照片不会上传。39 张真实笼卡回归中三字段严格正确 36 张；修正字段解析后为 37 张，连续识别平均约 2.66 秒/张（桌面 Chrome WASM，苹果手机耗时取决于机型）。

部署时将本目录内容放到 GitHub 仓库 `whoiswei114514/longka` 的 Pages 发布分支根目录。
