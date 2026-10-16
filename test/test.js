const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const {
  parseAssetMap,
  cookAssetMap,
  generateAssetMapHash,
  uploadAssetMap
} = require('../src/index');

const RUST_BIN = path.resolve(__dirname, '../extracted/macos/target/release/fullstory-asset-uploader');

console.log('=== Running FullStory Asset Uploader Node.js Port Tests ===\n');

// Helper to run original Rust binary generate command
function runRustGenerate(jsonObj, assetRoot = process.cwd()) {
  const inputStr = JSON.stringify(jsonObj);
  const out = execSync(`"${RUST_BIN}" generate -s -j -r "${assetRoot}" -`, {
    input: inputStr,
    encoding: 'utf-8'
  });
  return JSON.parse(out).assetMapHash;
}

// Test Cases for Hash Parity
const testCases = [
  {
    name: 'Empty asset map',
    input: {
      version: '2',
      assets: {}
    }
  },
  {
    name: 'Single data URL asset',
    input: {
      version: '2',
      assets: {
        'https://example.com/style.css': {
          content: 'data:text/css;base64,Ym9keSB7IGNvbG9yOiByZWQ7IH0='
        }
      }
    }
  },
  {
    name: 'Multiple assets with deduplication',
    input: {
      version: '2',
      assets: {
        'https://example.com/z.css': { content: 'data:text/css;base64,AAAA' },
        'https://example.com/a.css': { content: 'data:text/css;base64,AAAA' },
        'https://example.com/b.css': { content: 'data:text/css;base64,Ym9keSB7IGNvbG9yOiByZWQ7IH0=' }
      }
    }
  },
  {
    name: 'Parameterized URL with declared parameters',
    input: {
      version: '2',
      parameters: {
        v: { type: 'string', scope: 'document', default: '1.0.0' }
      },
      assets: {
        'https://example.com/v${v}/style.css': { content: 'data:text/css;base64,AAAA' },
        'https://example.com/base.css': { content: 'data:text/css;base64,AAAA' }
      }
    }
  },
  {
    name: 'Namespaced parameters (fs: and fullstory:)',
    input: {
      version: '2',
      parameters: {
        'fs:locale': { type: 'string', scope: 'document', default: 'en-US' },
        'fullstory:build': { type: 'string', scope: 'document' }
      },
      assets: {
        'https://example.com/${fs:locale}/app.js': { content: 'data:text/javascript;base64,Y29uc29sZS5sb2coMSk7' }
      }
    }
  },
  {
    name: 'Platform options with iOS fonts',
    input: {
      version: '2',
      assets: {
        'https://example.com/fonts/inter.ttf': { content: 'data:font/ttf;base64,AAAA' }
      },
      platform: {
        web: {},
        android: {},
        flutter: {},
        ios: {
          fonts: {
            Inter: {
              asset: 'https://example.com/fonts/inter.ttf'
            }
          }
        }
      }
    }
  }
];

// 1. Verify Hash Parity against Rust binary
console.log('--- 1. Testing Asset Map Hash Parity against Rust Binary ---');
for (const tc of testCases) {
  const rustHash = runRustGenerate(tc.input);
  const parsed = parseAssetMap(tc.input, process.cwd());
  const { canonicalJson } = cookAssetMap(parsed);
  const nodeHash = generateAssetMapHash(canonicalJson);

  assert.strictEqual(nodeHash, rustHash, `Hash mismatch in test case '${tc.name}'`);
  console.log(`✓ [PASSED] ${tc.name}`);
  console.log(`  Hash: ${nodeHash}`);
}

// 2. File-backed Asset Test
console.log('\n--- 2. Testing File-backed Assets ---');
const tmpDir = path.join(__dirname, 'tmp_assets');
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'test.css'), 'h1 { font-size: 24px; }', 'utf-8');

const fileTestCase = {
  version: '2',
  assets: {
    'https://example.com/test.css': {
      path: 'test.css'
    }
  }
};

const rustFileHash = runRustGenerate(fileTestCase, tmpDir);
const parsedFileMap = parseAssetMap(fileTestCase, tmpDir);
const { canonicalJson: fileCanonicalJson } = cookAssetMap(parsedFileMap);
const nodeFileHash = generateAssetMapHash(fileCanonicalJson);

assert.strictEqual(nodeFileHash, rustFileHash, 'File-backed asset hash mismatch');
console.log(`✓ [PASSED] File-backed asset hash matches Rust binary: ${nodeFileHash}`);

// Clean up temporary file
fs.rmSync(tmpDir, { recursive: true, force: true });

// 3. Mock Server Upload Flow Test
console.log('\n--- 3. Testing Full Upload Protocol (424 -> 201 Flow) ---');

let uploadMapCalls = 0;
let uploadAssetCalls = 0;
const uploadedHashes = [];

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');

    if (req.url === '/assets/v1/uploadMap') {
      uploadMapCalls++;
      if (uploadMapCalls === 1) {
        // First call: respond with 424 Failed Dependency (missing asset)
        res.writeHead(424, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          missingAssetHashes: ['sha256:5de625c36355cce7c1d5408826a0b21abfb49fb6c0e1f16c945a6f2aef38200c']
        }));
      } else {
        // Second call: finalized upload
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    } else if (req.url === '/assets/v1/upload') {
      uploadAssetCalls++;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

mockServer.listen(0, async () => {
  const port = mockServer.address().port;
  try {
    const uploadInput = {
      version: '2',
      assets: {
        'https://example.com/style.css': {
          content: 'data:text/css;base64,Ym9keSB7IGNvbG9yOiByZWQ7IH0='
        }
      }
    };

    const progressLogs = [];
    const result = await uploadAssetMap({
      inputJson: uploadInput,
      apiKey: 'test_admin_key_xyz',
      server: `http://127.0.0.1:${port}`,
      onProgress: (type, msg) => progressLogs.push({ type, msg })
    });

    assert.strictEqual(uploadMapCalls, 2, 'Expected 2 uploadMap calls (initial check and finalization)');
    assert.strictEqual(uploadAssetCalls, 1, 'Expected 1 upload call for missing asset');
    assert.strictEqual(result.status, 'uploaded');
    assert.strictEqual(result.assetMapHash, 'sha256:1b531396cb7c98b20fe11b04cfd6b96b4f9a9b378d7a3132fa0966469c3480ac');

    console.log(`✓ [PASSED] Mock server upload flow succeeded`);
    console.log(`  Initial 424 handled, missing asset uploaded, map finalized.`);
    console.log(`  Resulting Asset Map Hash: ${result.assetMapHash}`);
  } finally {
    mockServer.close();
  }

  console.log('\n=== All Tests Passed Successfully! ===\n');
});
