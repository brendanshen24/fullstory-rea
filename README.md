# fullstory-asset-uploader (Node.js Port)

A pure Node.js reimplementation of FullStory's `fullstory-asset-uploader` binary (v1.1.2) with zero runtime dependencies.

---

## Features

- **100% Hash Parity**: Produces the exact same deterministic asset map IDs as the official Rust binary.
- **Zero Runtime Dependencies**: Built entirely on Node.js built-ins (`crypto`, `zlib`, `fs`, `path`, `http`, `https`).
- **Complete CLI & Library**: Use as a command-line tool or import directly into your JavaScript / TypeScript projects.
- **Full Protocol Support**: Implements the chunked multipart protocol, including the `424 Failed Dependency` negotiation and concurrent asset uploads.

---

## Installation

```bash
# Link locally as a global or project binary
npm link
```

Or run directly via Node:

```bash
node bin/cli.js --help
```

---

## CLI Usage

### Generate an Asset Map ID
Compute the deterministic asset map ID without connecting to FullStory:

```bash
# From a file
node bin/cli.js generate ./path/to/asset-map.json

# From stdin
cat asset-map.json | node bin/cli.js generate -

# Output as JSON
node bin/cli.js generate -j ./path/to/asset-map.json
# Output: {"assetMapHash":"sha256:de64f9eab78e30ccc50942a4c5535c68509625f0898633185b68a712fb640eb0"}
```

### Upload an Asset Map
Upload the asset map and missing asset contents to FullStory:

```bash
node bin/cli.js upload --api-key "$FULLSTORY_API_KEY" ./path/to/asset-map.json
```

---

## Programmatic API

```javascript
const {
  parseAssetMap,
  cookAssetMap,
  generateAssetMapHash,
  uploadAssetMap
} = require('fullstory-asset-uploader');

// 1. Generate Asset Map ID
const inputMap = {
  version: "2",
  assets: {
    "https://example.com/styles.css": {
      content: "data:text/css;base64,Ym9keSB7IGNvbG9yOiByZWQ7IH0="
    }
  }
};

const parsed = parseAssetMap(inputMap, process.cwd());
const { canonicalJson } = cookAssetMap(parsed);
const assetMapHash = generateAssetMapHash(canonicalJson);

console.log('Asset Map ID:', assetMapHash);
// sha256:1b531396cb7c98b20fe11b04cfd6b96b4f9a9b378d7a3132fa0966469c3480ac

// 2. Upload to FullStory
await uploadAssetMap({
  inputJson: inputMap,
  apiKey: process.env.FULLSTORY_API_KEY,
  assetRoot: process.cwd(),
  onProgress: (type, msg) => console.log(msg)
});
```

---

## Testing

Run the test suite to verify hash parity against the official Rust binary:

```bash
npm test
```
