[English](./README.md)

# Obsidian 内容寻址附件插件

为附件实现内容寻址存储，提供类 IPFS 的功能，支持本地存储与外部网关/文件托管。

**注意**：本插件独立于官方 IPFS 网络，完全在您的本地 Obsidian 仓库内运行。外部网关是可选的，可根据需要配置。

## 功能特性

- **内容寻址存储**：基于内容寻址（CID 生成）存储附件，自动去重
- **IPFS 风格链接**：生成并解析 `ipfs://` 链接，支持 filename 与 format 参数
- **附件预处理**：在附件保存到 CAS 之前自动进行转换（例如通过 WebAssembly/JS 脚本将图片转为 WebP/AVIF、质量压缩、去除元数据）
- **网络文件锁定**：下载并缓存外部网络图片，带校验和验证，创建离线可用的弹性链接
- **多网关支持**：可配置的外部网关，支持自定义 URL 模板与请求头
- **加密支持**：为附件提供 AES-256-GCM 加密，支持保存时透明加密与读取时透明解密
- **密钥管理**：通过 Obsidian SecretStorage 创建、删除、导出、导入加密密钥
- **自动加密规则**：Gitignore 风格的路径规则，自动加密特定笔记中的附件
- **迁移工具**：
    - 将现有本地附件批量迁移为 IPFS 链接
    - 对当前笔记或整个仓库中的外部图片进行网络文件锁定
- **智能 URL 解析**：自动解析 `ipfs://` 链接，本地存储优先，外部网关兜底

## 安装

### 从 Obsidian 社区插件安装

1. 打开 Obsidian 设置 → 社区插件
2. 关闭安全模式
3. 浏览社区插件并搜索"Content-Addressed Attachments"
4. 安装并启用插件

### 手动安装

1. 从 GitHub 下载最新发布版本
2. 解压到仓库的插件目录：`.obsidian/plugins/content-addressed-attachments/`
3. 重新加载 Obsidian 并启用插件

## 使用方法

### 添加附件

- **拖放**：将文件拖入笔记，自动转换为 IPFS 链接
- **复制粘贴**：直接向笔记中粘贴文件
- **自动处理**：`ipfs://` 链接会自动解析为可访问的 URL

### Obsidian Base 卡片封面与 IPFS URL

Obsidian Base 的卡片视图封面属性只接受 `http(s)` URL 或本地附件链接，会直接丢弃 `ipfs://` / `internal.ipfs-locked:` 值。要让封面展示 IPFS 内容，用 `http:///` 前缀包装 IPFS 链接，使其通过 Obsidian 的前缀检查并保留在 DOM 中，插件会自动将其改写为可访问的本地资源 URL：

```markdown
---
cover: http:///ipfs://bafybei...
---
```

- `http:///` 仅是用于通过 Obsidian 检查的伪装前缀，插件会剥掉它并解析真实内容（桌面端与移动端均生效）
- 封面值中内嵌的 `ipfs://` 链接仍会被插件识别并纳入引用管理
- **`http:///` 前缀同样适用于普通 `<img src>` 属性** —— 你可以在卡片封面和正文中使用相同的链接引用同一份内容，无需维护两种格式：

```markdown
![正文中使用同一 IPFS 图片](http:///ipfs://bafybei...)
```

### 预处理附件

在附件保存到 CAS 存储之前自动进行转换（例如图片格式转换、质量调优）：

1. **选择预设或自定义脚本**：前往 设置 → Content-Addressed Attachments → 预处理脚本
   - 选择预设脚本（例如 ImageMagick WebP / AVIF 转换）
   - 或输入自定义脚本 URL（vault 相对路径、HTTPS URL 或 `internal.ipfs-locked:` 格式）
   - 通过 URL fragment 传递参数（例如 `#format=webp&quality=80`）

2. **非阻塞后台执行**：
   - 插入附件时，会立即在笔记中插入一个临时注释占位符（例如 `%% 正在预处理附件：image.png... %%`），保证编辑不被阻塞
   - 预处理在后台异步执行，完成后将占位符替换为最终的 `ipfs://` 链接

3. **开发与贡献自定义脚本**：
   - 了解如何编写 ESM 转换脚本或 JSON 清单：[预处理脚本开发指南](./docs/preprocess-scripts.zh-CN.md)。

### 锁定网络图片

"锁定"功能允许将外部网络图片（HTTP/HTTPS 链接）安全地缓存到本地：

1. **为什么要锁定图片？**
    - 即使原始链接失效也能保留网络图片
    - 通过 CID 校验和增加内容验证
    - 离线也能继续使用缓存的副本
    - 保证数据完整性与可用性

2. **如何锁定图片：**
    - **锁定当前笔记**：处理当前活动笔记中的所有外部图片链接（通过命令面板）
    - **锁定所有笔记**：处理整个仓库中的所有外部图片链接（通过 设置 → 高级操作）

3. **锁定流程：**
    - 从网络 URL 下载图片
    - 生成用于校验的 CID
    - 保存到配置的下载目录
    - 将原始链接替换为内部格式：`internal.ipfs-locked:<cid>,<original-url>`

### 加密附件

您可以为附件加密以保护敏感文件：

1. **创建加密密钥**：前往 设置 → Content-Addressed Attachments → 密钥管理
    - 创建新的加密密钥（可选命名）
    - 设置主密钥用于加密
    - 导出密钥进行备份（受密码保护）
    - 导入之前导出的密钥

2. **按路径自动加密**：配置 gitignore 风格的路径规则，自动加密匹配笔记中的附件
    - 每条规则可选指定使用的密钥
    - 未指定密钥时使用主密钥

3. **手动加密/解密**：右键点击任意 `ipfs://` 链接，可加密或解密附件

4. **透明解密**：加密附件在查看时会自动解密
    - 小文件在内存中解密
    - 大文件需要解密缓存目录（在设置中配置）

### 命令与设置

使用命令面板进行常用操作：

- **迁移本地文件**：
    - "Migrate local files (current note)" - 转换活动笔记中的本地附件

- **锁定网络文件**：
    - "Lock web files (current note)" - 锁定当前笔记中的图片

- **CAS 维护**：
    - "Restore referenced files from recycle bin" - 恢复仍被引用但已被删除到回收站的文件

### 高级操作（设置面板）

全库操作可在 设置 → Content-Addressed Attachments → 高级操作 中找到：

- **Migrate local files (all notes)** - 转换整个仓库中的本地附件
- **Lock web files (all notes)** - 锁定整个仓库中的图片

这些操作放置在设置中以防止误操作，因为它们会处理仓库中的所有笔记。

### 链接格式

```markdown
# IPFS 链接

![filename](ipfs://bafybei...?filename=image.jpg)
[filename](ipfs://bafybei...?filename=document.pdf)

# 锁定的网络图片（锁定后）

![Alt text](internal.ipfs-locked:bafybei...,https://example.com/image.jpg "Optional title")

# 加密附件

![filename](ipfs://bafybei...?filename=photo.jpg&format=application%2Fx.w1kxt3qz.encrypted)
```

## 配置

通过 设置 → Content-Addressed Attachments 配置：

- **预处理脚本**：选择预设或自定义转换脚本（例如 ImageMagick WebP/AVIF 格式转换），在附件存入 CAS 之前进行处理
- **本地存储目录**：内容寻址附件的存储路径
- **下载目录**：存储锁定网络图片的路径（可选，未设置时回退到主目录）
- **外部网关**：添加并配置多个文件获取网关
- **URL 模板**：使用 Mustache 模板语法自定义网关 URL
- **请求头**：为每个网关设置自定义请求头
- **内存解密上限**：内存中解密的文件大小上限（更大的文件需要解密缓存目录）
- **解密缓存目录**：临时解密文件的存放目录（请确保从同步工具中排除）
- **Secret Storage ID**：用于加密密钥存储的 Obsidian SecretStorage 密钥

## 迁移与锁定工具

这些工具提供详细的报告：

- **迁移工具**：
    - 成功迁移的本地文件
    - 跳过的文件（已是 IPFS 或外部链接）
    - 迁移失败的错误详情
    - 实时更新的进度跟踪

- **锁定工具**：
    - 成功锁定的网络图片
    - 跳过的链接（非 HTTP、已锁定等）
    - 下载失败与网络错误
    - 带取消选项的进度跟踪
    - 保留原始 alt 文本与标题

## 锁定网络图片的工作原理

当您锁定网络图片时：

1. **下载**：从原始 URL 下载图片
2. **校验**：根据文件内容计算 CID（内容标识符）
3. **存储**：保存到配置的下载目录
4. **链接替换**：原始链接格式：`internal.ipfs-locked:<cid>,<original-url>`
5. **解析**：插件按以下方式解析这些链接：
    - 首先检查本地存储（按 CID）
    - 本地缺失时，可从原始 URL 下载（带 CID 校验）
    - 面向未来：即使原始 URL 变化，CID 也能保证内容完整性

这种方法能抵御：

- 图片托管服务故障
- URL 变更
- 离线访问需求
- 内容篡改（CID 校验）
