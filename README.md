# Obsidian Content-Addressed Attachments Plugin

Implements content-addressed storage for attachments, providing IPFS-like functionality with local and external gateway/file-hosting support.

**Note**: This plugin is independent of the official IPFS network and operates entirely within your local Obsidian vault. External gateways are optional and configurable based on your needs.

## Features

- **Content-Addressed Storage**: Store attachments using content-based addressing (CID generation) with automatic deduplication
- **IPFS-style Links**: Generate and resolve `ipfs://` links with support for filename and format parameters
- **Web File Locking**: Download and cache external web images with checksum verification, creating resilient links that work offline
- **Multi-Gateway Support**: Configurable external gateways with customizable URL templates and request headers
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

### Locking Web Images

The "lock" feature allows you to securely cache external web images (HTTP/HTTPS links) locally:

1. **Why Lock Images?**
    - Preserve web images even if original links break
    - Add content verification with CID checksums
    - Continue working offline with cached copies
    - Maintain data integrity and availability

2. **How to Lock Images:**
    - **Lock current note**: Processes all external image links in the active note
    - **Lock all notes**: Processes all external image links across your entire vault
    - Access via command palette: "Add checksum and auto-cache for web files"

3. **Lock Process:**
    - Downloads images from web URLs
    - Generates CID checksum for verification
    - Saves to configured download directory
    - Replaces original links with internal format: `internal.ipfs-locked:<cid>,<original-url>`

### Migration Commands

Use the command palette to manage attachments:

- **Migrate Local Files**:
    - "Migrate local files (current note)" - Convert local attachments in active note
    - "Migrate local files (all notes)" - Convert local attachments across entire vault

- **Lock Web Images**:
    - "Add checksum and auto-cache for web files (current note)" - Lock images in active note
    - "Add checksum and auto-cache for web files (all notes)" - Lock images across entire vault

### Link Formats

```markdown
# IPFS Links

![filename](ipfs://bafybei...?filename=image.jpg)
[filename](ipfs://bafybei...?filename=document.pdf)

# Locked Web Images (after locking)

![Alt text](internal.ipfs-locked:bafybei...,https://example.com/image.jpg "Optional title")
```

## Configuration

Configure via Settings → Content-Addressed Attachments:

- **Local Storage Directory**: Path for content-addressed attachments storage
- **Download Directory**: Path for storing locked web images (optional, falls back to primary directory)
- **External Gateways**: Add and configure multiple gateways for file retrieval
- **URL Templates**: Customize gateway URLs using Mustache template syntax
- **Request Headers**: Set custom headers for each gateway

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
