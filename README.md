[简体中文](./README.zh.md)

# Obsidian Content-Addressed Attachments Plugin

Implements content-addressed storage for attachments, providing IPFS-like functionality with local and external gateway/file-hosting support.

**Note**: This plugin is independent of the official IPFS network and operates entirely within your local Obsidian vault. External gateways are optional and configurable based on your needs.

## Features

- **Content-Addressed Storage**: Store attachments using content-based addressing (CID generation) with automatic deduplication
- **IPFS-style Links**: Generate and resolve `ipfs://` links with support for filename and format parameters
- **Attachment Pre-processing**: Automate attachment transformations (e.g., image format conversion to WebP/AVIF, quality compression, metadata stripping via WebAssembly/JS scripts) before saving to CAS
- **Web File Locking**: Download and cache external web images with checksum verification, creating resilient links that work offline
- **Multi-Gateway Support**: Configurable external gateways with customizable URL templates and request headers
- **Encryption Support**: AES-256-GCM encryption for attachments with transparent encrypt-on-save and decrypt-on-read
- **Key Management**: Create, delete, export, and import encryption keys via Obsidian SecretStorage
- **Auto-Encrypt Rules**: Gitignore-style path rules to automatically encrypt attachments in specific notes
- **Migration Tools**:
    - Bulk migration of existing local attachments to IPFS links
    - Web file locking for external images in current note or entire vault
- **Smart URL Resolution**: Automatic resolution of `ipfs://` links with local storage priority and external gateway fallback

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings → Community Plugins
2. Disable Safe Mode
3. Browse Community Plugins and search for "Content-Addressed Attachments"
4. Install and enable the plugin

### Manual Installation

1. Download the latest release from GitHub
2. Extract to your vault's plugins folder: `.obsidian/plugins/content-addressed-attachments/`
3. Reload Obsidian and enable the plugin

## Usage

### Adding Attachments

- **Drag and Drop**: Drag files into notes for automatic IPFS link conversion
- **Copy and Paste**: Paste files directly into notes
- **Automatic Processing**: `ipfs://` links are automatically resolved to accessible URLs

### Obsidian Base Card Covers

Obsidian Base's card view cover property only accepts `http(s)` URLs or local attachment links, so `ipfs://` / `internal.ipfs-locked:` values are dropped. To display IPFS content as a cover, wrap the IPFS link with the `http:///` prefix so it passes Obsidian's prefix check and stays in the DOM; the plugin automatically rewrites it to an accessible local resource URL:

```markdown
---
cover: http:///ipfs://bafybei...
---
```

- The `http:///` prefix is only a disguise to pass Obsidian's check; the plugin strips it and resolves the real content (works on both desktop and mobile)
- The embedded `ipfs://` link in the cover value is still recognized and tracked by the plugin's reference management

### Pre-processing Attachments

Automatically transform attachments (e.g. image format conversion, quality tuning) before they are saved to CAS storage:

1. **Select Preset or Custom Script**: Go to Settings → Content-Addressed Attachments → Pre-processing script
   - Choose a preset script (e.g., ImageMagick WebP / AVIF conversion)
   - Or enter a custom script URL (vault-relative path, HTTPS URL, or `internal.ipfs-locked:` format)
   - Pass parameters via URL fragment (e.g., `#format=webp&quality=80`)

2. **Non-Blocking Background Execution**:
   - When inserting an attachment, a temporary comment placeholder (e.g., `%% Preprocessing attachment: image.png... %%`) is instantly inserted into your note so editing is never blocked
   - Pre-processing runs asynchronously in the background and replaces the placeholder with the final `ipfs://` link upon completion

3. **Developing & Contributing Custom Scripts**:
   - Learn how to author ESM transformation scripts or JSON manifests in the [Script Development Guide](./docs/preprocess-scripts.en.md).

### Locking Web Images

The "lock" feature allows you to securely cache external web images (HTTP/HTTPS links) locally:

1. **Why Lock Images?**
    - Preserve web images even if original links break
    - Add content verification with CID checksums
    - Continue working offline with cached copies
    - Maintain data integrity and availability

2. **How to Lock Images:**
    - **Lock current note**: Processes all external image links in the active note (via command palette)
    - **Lock all notes**: Processes all external image links across your entire vault (via Settings → Advanced operations)

3. **Lock Process:**
    - Downloads images from web URLs
    - Generates CID checksum for verification
    - Saves to configured download directory
    - Replaces original links with internal format: `internal.ipfs-locked:<cid>,<original-url>`

### Encrypting Attachments

You can encrypt attachments to protect sensitive files:

1. **Create Encryption Keys**: Go to Settings → Content-Addressed Attachments → Key Management
   - Create a new encryption key with an optional name
   - Set a primary key for encryption
   - Export keys for backup (password-protected)
   - Import previously exported keys

2. **Auto-Encrypt by Path**: Configure gitignore-style path rules to automatically encrypt attachments in matching notes
   - Each rule can optionally specify which key to use
   - If no key is specified, the primary key is used

3. **Manual Encrypt/Decrypt**: Right-click on any `ipfs://` link to encrypt or decrypt the attachment

4. **Transparent Decryption**: Encrypted attachments are automatically decrypted when viewed
   - Small files are decrypted in memory
   - Large files require a decrypted cache directory (configure in settings)

### Commands and Settings

Use the command palette for common operations:

- **Migrate Local Files**:
    - "Migrate local files (current note)" - Convert local attachments in active note

- **Lock Web Images**:
    - "Lock web files (current note)" - Lock images in active note

- **CAS Maintenance**:
    - "Restore referenced files from recycle bin" - Restore files that are still referenced but were deleted to the recycle bin

### Advanced Operations (Settings Panel)

Full-vault operations are available in Settings → Content-Addressed Attachments → Advanced operations:

- **Migrate local files (all notes)** - Convert local attachments across entire vault
- **Lock web files (all notes)** - Lock images across entire vault

These operations are placed in settings to prevent accidental execution, as they process all notes in your vault.

### Link Formats

```markdown
# IPFS Links

![filename](ipfs://bafybei...?filename=image.jpg)
[filename](ipfs://bafybei...?filename=document.pdf)

# Locked Web Images (after locking)

![Alt text](internal.ipfs-locked:bafybei...,https://example.com/image.jpg "Optional title")

# Encrypted Attachments

![filename](ipfs://bafybei...?filename=photo.jpg&format=application%2Fx.w1kxt3qz.encrypted)
```

## Configuration

Configure via Settings → Content-Addressed Attachments:

- **Pre-processing Script**: Select preset or custom transformation scripts (e.g. ImageMagick WebP/AVIF format conversion) for processing attachments before CAS storage
- **Local Storage Directory**: Path for content-addressed attachments storage
- **Download Directory**: Path for storing locked web images (optional, falls back to primary directory)
- **External Gateways**: Add and configure multiple gateways for file retrieval
- **URL Templates**: Customize gateway URLs using Mustache template syntax
- **Request Headers**: Set custom headers for each gateway
- **Max Memory Decryption Limit**: Maximum file size for in-memory decryption (larger files require decrypted cache directory)
- **Decrypted Cache Directory**: Directory for temporary decrypted files (ensure excluded from sync tools)
- **Secret Storage ID**: Obsidian SecretStorage key for encryption key storage

## Migration and Locking Tools

The tools provide detailed reporting:

- **Migration Tool**:
    - Successfully migrated local files
    - Skipped files (already IPFS or external links)
    - Error details for failed migrations
    - Progress tracking with real-time updates

- **Locking Tool**:
    - Successfully locked web images
    - Skipped links (non-HTTP, already locked, etc.)
    - Download failures and network errors
    - Progress tracking with cancel option
    - Maintains original alt text and titles

## How Locked Images Work

When you lock a web image:

1. **Download**: Image is downloaded from the original URL
2. **Checksum**: CID (Content ID) is calculated from the file content
3. **Storage**: Saved locally in the download directory
4. **Link Replacement**: Original link format: `internal.ipfs-locked:<cid>,<original-url>`
5. **Resolution**: The plugin resolves these links by:
    - First checking local storage (by CID)
    - If missing locally, can download from the original URL (with CID check)
    - Future-proof: even if original URL changes, the CID ensures content integrity

This approach provides resilience against:

- Broken image hosting
- Changed URLs
- Offline access needs
- Content tampering (CID verification)
