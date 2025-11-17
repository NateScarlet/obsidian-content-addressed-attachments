# Obsidian Content-Addressed Attachments Plugin

Implements content-addressed storage for attachments, providing IPFS-like functionality with local and external gateway/file-hosting support.

**Note**: This plugin is independent of the official IPFS network and operates entirely within your local Obsidian vault. External gateways are optional and configurable based on your needs.

## Features

- **Content-Addressed Storage**: Store attachments using content-based addressing (CID generation) with automatic deduplication
- **IPFS-style Links**: Generate and resolve `ipfs://` links with support for filename and format parameters
- **Multi-Gateway Support**: Configurable external gateways with customizable URL templates and request headers
- **Migration Tools**: Bulk migration of existing attachments to IPFS links for current note or entire vault
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

### Migration Commands

Use the command palette to migrate existing attachments:

- **"Migrate files in current note"** - Convert attachments in active note
- **"Migrate files in all notes"** - Convert attachments across entire vault

### Link Formats

```markdown
![filename](ipfs://bafybei...?filename=image.jpg)
[filename](ipfs://bafybei...?filename=document.pdf)
```

## Configuration

Configure via Settings → Content-Addressed Attachments:

- **Local Storage Directory**: Path for content-addressed attachments storage
- **External Gateways**: Add and configure multiple gateways for file retrieval
- **URL Templates**: Customize gateway URLs using Mustache template syntax
- **Request Headers**: Set custom headers for each gateway

## Migration

The migration tool provides detailed reporting:

- Successfully migrated files
- Skipped files (already IPFS or external links)
- Error details for failed migrations
- Progress tracking with real-time updates

## Support

For issues and troubleshooting:

- Check gateway configuration and connectivity
- Verify local storage directory permissions
- Review migration reports for specific error details
- Enable debug logging for detailed operation information
