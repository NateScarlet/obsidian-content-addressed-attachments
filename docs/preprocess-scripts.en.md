[简体中文](./preprocess-scripts.zh-CN.md)

# Pre-processing Script Development Guide

The pre-processing pipeline allows transforming attachment files (e.g., image format conversion, quality compression, metadata stripping) automatically before they are saved to Content-Addressed Storage (CAS) and linked in Obsidian notes.

---

## 1. Script URL Specification (`scriptURL`)

The plugin loads and executes pre-processing scripts based on the `scriptURL` in settings. The `scriptURL` supports the following formats:

| Format | Example / Description |
| --- | --- |
| **Vault-relative path** | `.obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts/imagemagick.json` |
| **HTTPS URL** | `https://example.com/scripts/my-script.json` |
| **IPFS Locked Format** | `internal.ipfs-locked:<manifestCID>,<https-url>` |
| **IPFS Protocol** | `ipfs://<cid>` |

### Passing Parameters via URL Fragment
Parameters are passed via the URL hash/fragment. The plugin automatically parses them into a `URLSearchParams` object passed to the script context:
```text
.obsidian/plugins/.../imagemagick.json#format=webp&quality=80
```

---

## 2. Module Interface & Contract

A pre-processing script must be a standard **ESM (ECMAScript Module)** module that exports a default transformation function (`export default`).

### TypeScript Type Definitions

```ts
/** Input file information */
export interface PreProcessInput {
  /** Original binary data */
  data: ArrayBuffer;
  /** File MIME type (e.g., "image/png") */
  mimeType: string;
  /** Original filename */
  filename: string;
}

/** Script execution context */
export interface PreProcessContext {
  /** Log notification function (displays a Notice in Obsidian) */
  log: (message: string) => void;
  /** Parameters parsed from the scriptURL fragment */
  params: URLSearchParams;
  /** Helper function to derive MIME type from file extension */
  mimeTypeByExtension: (ext: string) => string;
}

/** Transformed output result */
export interface PreProcessOutput {
  /** Transformed binary data */
  data: ArrayBuffer;
  /** Output MIME type (e.g., "image/webp") */
  mimeType: string;
  /** Output filename (e.g., "sample.webp") */
  filename: string;
}

/** Script default export signature */
export default function transform(
  input: PreProcessInput,
  ctx: PreProcessContext
): Promise<PreProcessOutput | undefined> | PreProcessOutput | undefined;
```

> **Note**: If the script determines that the file does not need transformation (e.g., it is already in the target format or compression did not save space), return `undefined` to preserve and store the original file.

---

## 3. Single-File Scripts vs. Multi-File Manifests

Pre-processing scripts can be published in two forms:

### 3.1 Single-File Script (`.js`)
Suitable for simple logic without large external dependencies. The `scriptURL` points directly to the `.js` file.

### 3.2 Multi-File Manifest (`.json`)
When a script depends on additional assets (such as WASM modules or data files), use a per-script JSON manifest:

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

- **Mechanism**: The plugin loader automatically downloads and unpacks all files in the manifest into `<pluginDir>/preprocess-scripts/<manifestCID>/` cache directory based on CIDs and `sources`, and then imports the `entry` file.
- **Resource Resolution**: In the `entry` script, companion assets can be loaded relative to `import.meta.url`:
  ```ts
  const wasmURL = new URL("magick.wasm", import.meta.url);
  const response = await fetch(wasmURL);
  ```

---

## 4. Example Script Code Walkthrough (`imagemagick.ts`)

The `preprocess-scripts/imagemagick.ts` file in this repository provides a complete reference implementation using `@imagemagick/magick-wasm`:

- Source code: `preprocess-scripts/imagemagick.ts`
- Build script: `scripts/build-preprocess-scripts.mjs`

### Reading Fragment Parameters in Code
```ts
// Scripts read URL fragment parameters via ctx.params (e.g. #format=webp&quality=80)
const format = ctx.params.get("format") || "avif";
const quality = parseInt(ctx.params.get("quality") || "80", 10);

// Perform ImageMagick WASM transformation...
```

---

## 5. Contributing Preset Scripts (`registry.json`)

If you have developed a useful pre-processing script and want to share it with other users, you are welcome to submit it to the registry `preprocess-scripts/registry.json`.

### Submission Steps

1. **Host and Publish Your Script**:
   Publish your `.js` script or `.json` manifest to a public network endpoint (such as GitHub Releases, GitHub Gist, or any HTTPS server).

2. **Submit a Pull Request**:
   Fork this repository and append a new entry to `preprocess-scripts/registry.json`:
   ```json
   [
     {
       "name": "Script Name",
       "description": "Short description of functionality and options",
       "scriptURL": "preprocess-scripts/my-script.json#format=webp&quality=80"
     }
   ]
   ```

### 3. Field Descriptions & PR Pinning Mechanism

- `name` *(string)*: Script display name shown in the settings preset dropdown menu.
- `description` *(string)*: Short description of script features.
- `scriptURL` *(string)*: Public HTTPS URL to the script/manifest (optionally with fragment parameters), or directly formatted as `internal.ipfs-locked:`.

> ⚠️ **PR Pinning & Security Locking Mechanism**:
> To prevent external servers from silently modifying script logic later (which could exploit script execution to gain unauthorized access to users' local Obsidian vaults), community scripts **are never kept as raw unpinned HTTP(S) URLs in the registry**.
>
> 1. **PR Submission**: Contributors may submit standard HTTPS URLs in their PR.
> 2. **PR Review & Merge**: Maintainers run the pin script when reviewing and accepting the PR:
>    ```bash
>    pnpm run preprocess:pin-registry
>    ```
>    This command fetches the script, computes its SHA-256 CID hash, and **pins the URL in-place within `registry.json` to `internal.ipfs-locked:<CID>,<HTTPS_URL>`** before merging.
> 3. **Script Updates**: If the author releases a new version of the script later, **they must submit a new PR**. Remote file changes on external servers without a new PR update will fail CID verification and be rejected at runtime by the plugin.

