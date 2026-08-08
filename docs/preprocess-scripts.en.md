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
    },
    "imagemagick.worker.js": {
      "cid": "bafkreib...",
      "sources": [
        ".obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts/imagemagick.worker.js",
        "https://example.com/releases/download/v0.1.0/imagemagick.worker.js"
      ]
    }
  }
}
```

- **Mechanism**: The plugin loader automatically downloads and unpacks all files in the manifest into `<pluginDir>/preprocess-scripts/<manifestCID>/` cache directory based on CIDs and `sources`, and then imports the `entry` file.
- **Resource Resolution**: `files` is not limited to the entry script — it can hold WASM modules, workers, data files, or any other runtime dependency, all downloaded into the same directory. In the `entry` script, companion assets can be loaded relative to `import.meta.url`:
  ```ts
  const wasmURL = new URL("magick.wasm", import.meta.url);
  const response = await fetch(wasmURL);
  ```
- The built-in ImageMagick preset uses a multi-file manifest to ship `magick.wasm` and a Web Worker script (`imagemagick.worker.js`, which runs the synchronous transcoding in a background thread to avoid blocking the UI) alongside the entry script.

---

## 4. Minimal Example: Writing a Script (Quick Start)

Below is a self-contained, complete example that depends on no external libraries. The built-in ImageMagick preset (`preprocess-scripts/imagemagick.ts`) is a more complete, ready-to-use reference implementation.

### 4.1 Create the Script

Save the following code as `scripts/my-script.js` inside your vault:

```js
// scripts/my-script.js
// Minimal example: read a parameter from the URL fragment and prefix every
// attachment filename. No external dependencies; return undefined to keep
// the original file.
export default async function transform(input, ctx) {
  // ctx.params comes from the scriptURL fragment (e.g. #prefix=draft)
  const prefix = ctx.params.get("prefix");

  // ctx.log shows a notice in Obsidian
  ctx.log(`Processing ${input.filename} (${input.mimeType})`);

  // No prefix parameter → keep the original file
  if (!prefix) {
    return undefined;
  }

  return {
    data: input.data,           // pass data through unchanged
    mimeType: input.mimeType,   // keep the original MIME type
    filename: `${prefix}-${input.filename}`, // rename only
  };
}
```

### 4.2 Configure and Use

Enter a vault-relative path in the plugin's pre-processing setting (optionally with fragment parameters):

```text
scripts/my-script.js#prefix=draft
```

Attachments inserted afterwards will be named `draft-<original>`; drop the fragment parameters to keep the original files.

### 4.3 Key Points

- **Default export function**: `(input, ctx) => PreProcessOutput | undefined`, synchronous or returning a `Promise`.
- **Return `undefined`**: means "keep the original file" (e.g. input is already the target format, or compression is not worthwhile).
- **`ctx.params`**: a `URLSearchParams` parsed from the URL fragment; scripts never parse the URL themselves.
- When the script needs WASM / Worker / data-file dependencies, switch to a multi-file manifest (see section 3).

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
       "scriptURL": "https://example.com/path/to/script.json#format=webp&quality=80"
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

