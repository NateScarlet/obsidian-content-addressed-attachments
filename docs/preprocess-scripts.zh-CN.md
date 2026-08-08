[English](./preprocess-scripts.en.md)

# 预处理脚本开发指南 (Pre-processing Script Guide)

预处理管线允许在附件被保存至 CAS (Content-Addressed Storage) 存储并插入 Obsidian 笔记前，对其进行自动化处理（例如图片格式转换、质量压缩、元数据清理等）。

---

## 1. 脚本 URL 规范 (`scriptURL`)

插件根据设置中的 `scriptURL` 加载并执行预处理脚本。`scriptURL` 支持以下格式：

| 格式 | 示例 / 说明 |
| --- | --- |
| **Vault 相对路径** | `.obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts/imagemagick.json` |
| **HTTPS URL** | `https://example.com/scripts/my-script.json` |
| **IPFS 锁定格式** | `internal.ipfs-locked:<manifestCID>,<https-url>` |
| **IPFS 协议** | `ipfs://<cid>` |

### URL Fragment 参数传递
脚本参数通过 URL 的 Hash / Fragment 传入，插件会自动将其解析为 `URLSearchParams` 传递给脚本上下文：
```text
.obsidian/plugins/.../imagemagick.json#format=webp&quality=80
```

---

## 2. 模块接口约定

预处理脚本必须为标准 **ESM (ECMAScript Module)** 模块，默认导出（`export default`）一个转换函数。

### TypeScript 类型定义

```ts
/** 输入文件信息 */
export interface PreProcessInput {
  /** 文件原始二进制数据 */
  data: ArrayBuffer;
  /** 文件的 MIME 类型（例如 "image/png"） */
  mimeType: string;
  /** 原始文件名 */
  filename: string;
}

/** 脚本执行上下文 */
export interface PreProcessContext {
  /** 日志输出方法（在 Obsidian 中显示通知） */
  log: (message: string) => void;
  /** 从 URL fragment 解析出的参数对象 */
  params: URLSearchParams;
}

/** 转换后的输出结果 */
export interface PreProcessOutput {
  /** 转换后的二进制数据 */
  data: ArrayBuffer;
  /** 转换后的 MIME 类型（例如 "image/webp"） */
  mimeType: string;
  /** 转换后的文件名（例如 "sample.webp"） */
  filename: string;
}

/** 脚本默认导出接口 */
export default function transform(
  input: PreProcessInput,
  ctx: PreProcessContext
): Promise<PreProcessOutput | undefined> | PreProcessOutput | undefined;
```

> **注意**：如果脚本判断当前文件无需处理（例如输入文件已经是目标格式，或压缩后体积未减少），请直接返回 `undefined`，插件将保留原始文件落盘。

---

## 3. 单文件脚本与多文件清单 (Manifest)

预处理脚本支持两种打包发布形式：

### 3.1 单文件脚本 (`.js`)
适用于逻辑简单、无外部大型资源依赖的脚本。`scriptURL` 直接指向 `.js` 文件。

### 3.2 多文件清单 (`.json`)
当脚本依赖其他资源（如 WASM 模块、数据文件）时，建议使用 per-script JSON 清单：

```json
{
  "entry": "imagemagick.js",
  "files": {
    "imagemagick.js": {
      "cid": "bafkreidmbbje2ti4lj6lzb5zxj7j2i6mf5gx6xowzgzzzsxg65tujkt7we",
      "sources": [
        ".obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts/imagemagick.js",
        "https://example.com/releases/download/v0.1.0/imagemagick.js"
      ]
    },
    "magick.wasm": {
      "cid": "bafkreia...",
      "sources": [
        ".obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts/magick.wasm",
        "https://example.com/releases/download/v0.1.0/magick.wasm"
      ]
    }
  }
}
```

- **工作机制**：插件加载器会根据 CID 和 `sources` 自动下载并解包清单中的所有文件到 `<pluginDir>/preprocess-scripts/<manifestCID>/` 缓存目录中，然后加载 `entry` 文件。
- **资源定位**：在 `entry` 脚本中，可以通过 `import.meta.url` 相对加载同目录资源：
  ```ts
  const wasmURL = new URL("magick.wasm", import.meta.url);
  const response = await fetch(wasmURL);
  ```

---

## 4. 示例脚本代码解析 (`imagemagick.ts`)

仓库中的 `preprocess-scripts/imagemagick.ts` 提供了使用 `@imagemagick/magick-wasm` 实现多格式图片转换的完整参考实现：

- 源码位置：`preprocess-scripts/imagemagick.ts`
- 构建配置：`scripts/build-preprocess-scripts.mjs`

### 脚本参数读取示例
```ts
// 脚本在转换逻辑中通过 ctx.params 读取 Fragment 参数（如 #format=webp&quality=80）
const format = ctx.params.get("format") || "avif";
const quality = parseInt(ctx.params.get("quality") || "80", 10);

// 调用 ImageMagick WASM 执行转码与压缩...
```

---

## 5. 贡献社区预设脚本 (`registry.json`)

如果您开发了有用的预处理脚本并希望分享给其他用户，欢迎将其提交至注册表 `preprocess-scripts/registry.json`。

### 提交步骤

1. **托管与发布脚本**：
   将您开发的 `.js` 脚本或 `.json` 清单发布到公开网络（例如 GitHub Releases、GitHub Gist 或任意 HTTPS 服务器）。

2. **提交 Pull Request**：
   Fork 本项目仓库，在 `preprocess-scripts/registry.json` 文件中追加您的脚本条目：
   ```json
   [
     {
       "name": "脚本名称",
       "description": "简短描述该脚本的功能与作用（如转换格式、压缩参数等）",
       "scriptURL": "https://example.com/path/to/script.json#format=webp&quality=80"
     }
   ]
   ```

### 3. 字段说明与 PR 接受时的 CID 锁定机制 (Pinning)

- `name` *(string)*: 脚本名称，将直接展示在插件设置页面的预设下拉菜单中。
- `description` *(string)*: 脚本的功能说明描述。
- `scriptURL` *(string)*: 脚本或清单的公开 HTTPS URL，可以包含 Hash fragment 作为默认参数（或直接填入 `internal.ipfs-locked:` 格式）。

> ⚠️ **PR 接受时的 CID 锁定机制（防篡改与越权）**：
> 为防止外部服务器后续擅自篡改脚本内容（利用动态修改的代码侵入用户本地 Obsidian 库），社区脚本**绝不允许直接以裸 HTTP(S) URL 长期保存在注册表中**。
>
> 1. **PR 提交阶段**：贡献者提交 PR 时可以填入标准的 HTTPS URL。
> 2. **PR 审核与合并阶段**：仓库维护者在接受 PR 时会运行 Pin 脚本：
>    ```bash
>    pnpm run preprocess:pin-registry
>    ```
>    该脚本会直接抓取该 HTTPS 脚本的内容，计算其 SHA-256 哈希 CID，并将 `registry.json` 中对应的 `scriptURL` **原地替换并锁定为 `internal.ipfs-locked:<CID>,<HTTPS_URL>`** 格式再合并入主分支。
> 3. **后续版本更新**：若作者后续发布了新版本脚本，**必须重新提交 PR**。未经 PR 代码审核并更新 CID 锁定的远程文件修改，会在插件运行时因 CID 校验失败而被拒绝执行。

