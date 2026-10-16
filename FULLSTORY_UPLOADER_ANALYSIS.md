# FullStory Asset Uploader Reverse Engineering Dossier

**Target**: `fullstory-asset-uploader` (v1.1.2)  
**Binaries Analyzed**:
* macOS: `target/release/fullstory-asset-uploader` (Mach-O 64-bit arm64, Apple Distribution Signed: FullStory, Inc. `8Q8W5KSX6X`)
* Linux: `target/x86_64-unknown-linux-musl/release/fullstory-asset-uploader` (ELF 64-bit LSB static-pie, unstripped with full DWARF debug info)

---

## 1. Architectural Overview & Toolchain

The application is written in **Rust** and structured into an internal workspace consisting of four crates:

* **`fullstory-asset-uploader`**: CLI parsing, execution pipeline, exit codes, and diagnostic reporting (`main.rs`, `config.rs`, `tasks.rs`, `diagnostics.rs`).
* **`asset-map`**: Strict parser and validation engine for input JSON asset maps (`parser/mod.rs`, `parser/error.rs`).
* **`asset-map-ops`**: Core operations engine covering serialization, compression, hashing, and HTTP communications (`upload/mod.rs`, `serialize/mod.rs`, `metadata.rs`, `compress/mod.rs`).
* **`progress`**: Multi-threaded progress bar and console UI orchestration wrapping `indicatif`.

### Key Dependencies & Runtime
* **Async Runtime & Networking**: `tokio` (multi-threaded work-stealing runtime), `reqwest` (HTTP client), `hyper`, `h2` (HTTP/2 framing), `native-tls` / `openssl-probe`.
* **Serialization & CLI**: `clap 3.x`, `serde`, `serde_json`, `indexmap` (preserving determinism), `data-url` (RFC 2397).
* **Compression & Hashing**: `miniz_oxide` / `flate2` (gzip), SHA-256 (`digest::Digest`).

---

## 2. Command-Line Interface

```
fullstory-asset-uploader [OPTIONS] [SUBCOMMAND]
```

### Global Options
| Option | Environment Variable | Description |
| :--- | :--- | :--- |
| `-j, --json` | — | Emits machine-readable JSON (e.g. `{"assetMapHash": "sha256:..."}`). |
| `-t, --text` | — | Emits human-readable colored terminal output (Default). |
| `-s, --silent` | — | Silences progress bars and non-essential status logs. |
| `-p, --parallel <N>` | — | Sets max worker threads/concurrency (must be a positive integer). |
| `-V, --version` | — | Prints version string (`1.1.2`). |

### Subcommands

#### `generate [OPTIONS] <ASSET MAP>`
Computes and prints the deterministic asset map ID / hash without connecting to FullStory.
* `<ASSET MAP>`: Path to JSON asset map file, or `-` to read from `stdin`.
* `-r, --asset-root <DIR>`: Base directory for resolving relative asset paths (defaults to parent directory of asset map, or CWD if reading from stdin).

#### `upload [OPTIONS] --api-key <KEY> <ASSET MAP>`
Uploads the asset map and missing asset contents to FullStory.
* `-k, --api-key <KEY>`: FullStory Admin API key (**Env**: `FULLSTORY_API_KEY`).
* `--server <URL>`: Asset server URL (**Env**: `FULLSTORY_ASSET_SERVER`, default: `https://api.fullstory.com`).
* `-r, --asset-root <DIR>`: Base directory for asset file paths.

---

## 3. Asset Map Schema (Input v2 Specification)

The parser enforces strict schema validation: unexpected properties trigger hard errors.

```jsonc
{
  // 1. Version: MUST be the constant string "2"
  "version": "2",

  // 2. Parameters (Optional): Declares template variables for dynamic URL patterns
  "parameters": {
    "v": {
      "type": "string",       // Must be constant "string"
      "scope": "document",    // Must be constant "document"
      "default": "1.0.0"      // Optional default string
    },
    // Parameter names can optionally be namespaced: only "fs:" and "fullstory:" prefixes allowed
    "fs:locale": {
      "type": "string",
      "scope": "document"
    }
  },

  // 3. Assets (Required): Map of absolute or parameterized URLs to source definitions
  "assets": {
    // File-backed asset (resolved against --asset-root)
    "https://example.com/assets/logo.png": {
      "path": "images/logo.png"
    },
    // Inline data URL asset (RFC 2397)
    "https://example.com/styles/app.css": {
      "content": "data:text/css;base64,Ym9keSB7IGNvbG9yOiBibHVlOyB9"
    },
    // Parameterized URL pattern (references declared parameter)
    "https://example.com/v${v}/app.js": {
      "path": "dist/app.js"
    }
  },

  // 4. Platform options (Optional)
  "platform": {
    "web": {},
    "android": {},
    "flutter": {},
    "ios": {
      "fonts": {
        "CustomFont": {
          "asset": "https://example.com/assets/custom.ttf" // Must match an asset URL above
        }
      }
    }
  }
}
```

---

## 4. Internal "Cooked" JSON & Asset Map ID Derivation

The uploader does not upload raw asset maps. Instead, it normalizes, deduplicates, and compiles the map into an internal **"Cooked Asset Map"**:

```
[Raw Asset Map]
       │
       ▼
 [Read & Hash Content]  ──► SHA-256 computed on raw decoded file/data-URL bytes
       │
       ▼
 [Cooked Inversion]     ──► Inverts mapping: Group all URLs by SHA-256 content hash
       │
       ▼
 [Canonical Key Sort]   ──► Stable sort on all IndexMap keys & URL patterns
       │
       ▼
 [Gzip Compression]     ──► Compresses canonical JSON with Gzip (application/gzip)
       │
       ▼
 [Asset Map Hash]       ──► SHA-256 digest of the gzipped bytes -> "sha256:<hex>"
```

### The Cooked JSON Format
```json
{
  "assetHashes": {
    "sha256:5de625c3...": {
      "urlPattern": [
        { "url": "https://example.com/style.css" },
        { "template": [ { "literal": "https://example.com/v" }, { "param": "v" }, { "literal": "/style.css" } ] }
      ]
    }
  },
  "parameters": {
    "v": {
      "default": "1.0.0",
      "namespace": null,
      "scope": "document",
      "type": "string"
    }
  },
  "platform": {
    "android": {},
    "flutter": {},
    "ios": { "fonts": {} },
    "web": {}
  },
  "version": "2"
}
```

---

## 5. Network Protocol & Upload Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Client as fullstory-asset-uploader
    participant Server as FullStory Asset API (api.fullstory.com)

    Note over Client,Server: Phase 1: Upload / Verify Asset Map
    Client->>Server: POST /assets/v1/uploadMap<br/>Headers: Authorization: Basic <API_KEY><br/>Multipart Body: contentHash + Gzipped Cooked JSON
    alt Map Already Cached
        Server-->>Client: 200 OK
        Note over Client: Prints "Asset map is already present."
    alt All Assets Exist
        Server-->>Client: 201 Created
        Note over Client: Prints "No new assets found."
    alt Assets Missing in Backend
        Server-->>Client: 424 Failed Dependency<br/>Body: {"missingAssetHashes": ["sha256:abc...", ...]}
        Note over Client: Prints "New assets found."
        
        Note over Client,Server: Phase 2: Upload Missing Individual Assets
        loop For each missing asset hash in parallel
            Client->>Server: POST /assets/v1/upload<br/>Headers: Authorization: Basic <API_KEY><br/>Multipart Body: contentHash + Gzipped Raw Asset
            Server-->>Client: 201 Created
        end

        Note over Client,Server: Phase 3: Finalize Asset Map
        Client->>Server: POST /assets/v1/uploadMap<br/>Multipart Body: contentHash + Gzipped Cooked JSON
        Server-->>Client: 201 Created
    end
    Note over Client: Prints Final Asset Map ID ("sha256:...")
```

### Protocol Request Specifications

1. **Authentication Header**:
   ```http
   Authorization: Basic <API_KEY>
   User-Agent: fullstory-asset-uploader 1.1.2
   ```
   *(Note: The API key is sent directly as the Basic credential string without username/password colon encoding).*

2. **`POST /assets/v1/uploadMap`**:
   * `Content-Type: multipart/form-data; boundary=...`
   * `Transfer-Encoding: chunked`
   * Form Parts:
     * `contentHash`: ASCII string `sha256:<64-char hex of gzipped cooked json>`
     * `content`: Gzip-compressed cooked JSON payload (`Content-Type: application/gzip`, `filename="sha256:<asset_map_hash>"`).

3. **`POST /assets/v1/upload`**:
   * `Content-Type: multipart/form-data; boundary=...`
   * `Transfer-Encoding: chunked`
   * Form Parts:
     * `contentHash`: ASCII string `sha256:<64-char hex of raw uncompressed asset>`
     * `content`: Gzip-compressed raw asset bytes (`Content-Type: application/gzip`, `filename="sha256:<asset_hash>"`).

4. **Retry Mechanism**:
   * Transient network or server errors are retried up to **3 times** with exponential backoff (`Retrying... Retry count: 0, 1, 2`).
