const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');

const VERSION = '1.1.2';
const DEFAULT_SERVER = 'https://api.fullstory.com';

/**
 * Validates parameter name.
 * Accepts:
 *   - Simple identifier: ^[a-zA-Z_][a-zA-Z0-9_]*$ or ^[a-zA-Z0-9_]+$ (tested: 'a', 'a_b', 'A', 'a1' valid; '1a' invalid)
 *   - Namespaced identifier: ^(fs|fullstory):[a-zA-Z0-9_]+$
 */
function parseParameterName(name) {
  const colonIdx = name.indexOf(':');
  if (colonIdx !== -1) {
    const ns = name.slice(0, colonIdx);
    const id = name.slice(colonIdx + 1);
    if (ns !== 'fs' && ns !== 'fullstory') {
      throw new Error(`Invalid parameter namespace: ${ns}:.`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
      throw new Error(`Invalid parameter name: ${name}`);
    }
    return { name, namespace: ns, localName: id };
  } else {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid parameter name.`);
    }
    return { name, namespace: null, localName: name };
  }
}

/**
 * Parse RFC 2397 Data URL
 */
function parseDataUrl(dataUrlStr) {
  if (!dataUrlStr.startsWith('data:')) {
    throw new Error('Invalid data URL.');
  }
  const commaIdx = dataUrlStr.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Invalid data URL.');
  }
  const meta = dataUrlStr.slice(5, commaIdx);
  const data = dataUrlStr.slice(commaIdx + 1);

  const isBase64 = meta.endsWith(';base64');
  let mimeType = isBase64 ? meta.slice(0, -7) : meta;
  if (!mimeType) mimeType = 'text/plain;charset=US-ASCII';

  let buffer;
  if (isBase64) {
    buffer = Buffer.from(data, 'base64');
  } else {
    buffer = Buffer.from(decodeURIComponent(data), 'utf-8');
  }
  return { mimeType, buffer };
}

/**
 * Parse URL pattern and extract template components (${param})
 */
function parseUrlPattern(patternStr, declaredParams) {
  // Check for parameter references: ${...}
  const paramRegex = /\$\{([^}]+)\}/g;
  let hasParams = false;
  let match;
  let lastIndex = 0;
  const components = [];

  while ((match = paramRegex.exec(patternStr)) !== null) {
    hasParams = true;
    const literalPart = patternStr.slice(lastIndex, match.index);
    if (literalPart.length > 0) {
      components.push({ literal: literalPart });
    }
    const paramName = match[1];
    if (!declaredParams.has(paramName)) {
      throw new Error(`Reference to undeclared parameter '${paramName}'.`);
    }
    components.push({ param: paramName });
    lastIndex = paramRegex.lastIndex;
  }

  if (lastIndex < patternStr.length) {
    components.push({ literal: patternStr.slice(lastIndex) });
  }

  // Basic validation that it represents an absolute URL (starts with scheme://)
  const probeUrl = patternStr.replace(/\$\{[^}]+\}/g, 'placeholder');
  try {
    const parsed = new URL(probeUrl);
    if (!parsed.protocol) throw new Error();
  } catch {
    throw new Error(`An absolute URL is required.`);
  }

  if (hasParams) {
    return { type: 'template', components, raw: patternStr };
  } else {
    return { type: 'url', url: patternStr, raw: patternStr };
  }
}

/**
 * Strict object validation checking for unknown keys
 */
function checkKnownProperties(obj, allowedKeys, contextDesc) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`Expected object.`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) {
      throw new Error(`Unknown properties are not allowed.`);
    }
  }
}

/**
 * Parse and validate asset map JSON input
 */
function parseAssetMap(jsonObj, assetRoot) {
  checkKnownProperties(jsonObj, ['version', 'parameters', 'assets', 'platform'], 'root');

  if (jsonObj.version === undefined) {
    throw new Error("Missing required property 'version'.");
  }
  if (typeof jsonObj.version !== 'string') {
    throw new Error('Expected string.');
  }
  if (jsonObj.version !== '2') {
    throw new Error("Expected the constant '2'.");
  }

  if (jsonObj.assets === undefined) {
    throw new Error("Missing required property 'assets'.");
  }
  checkKnownProperties(jsonObj.assets, Object.keys(jsonObj.assets), 'assets');

  // Parse parameters if present
  const parsedParams = new Map();
  if (jsonObj.parameters !== undefined) {
    checkKnownProperties(jsonObj.parameters, Object.keys(jsonObj.parameters), 'parameters');
    for (const [paramKey, paramDecl] of Object.entries(jsonObj.parameters)) {
      const parsedName = parseParameterName(paramKey);
      checkKnownProperties(paramDecl, ['type', 'scope', 'default'], `parameter ${paramKey}`);

      if (paramDecl.type !== undefined) {
        if (typeof paramDecl.type !== 'string') throw new Error('Expected string.');
        if (paramDecl.type !== 'string') throw new Error("Expected the constant 'string'.");
      }
      if (paramDecl.scope !== undefined) {
        if (typeof paramDecl.scope !== 'string') throw new Error('Expected string.');
        if (paramDecl.scope !== 'document') throw new Error("Expected the constant 'document'.");
      }
      let defaultVal = null;
      if (paramDecl.default !== undefined) {
        if (typeof paramDecl.default !== 'string') throw new Error('Expected string.');
        defaultVal = paramDecl.default;
      }
      parsedParams.set(paramKey, {
        name: paramKey,
        namespace: parsedName.namespace,
        scope: 'document',
        type: 'string',
        default: defaultVal
      });
    }
  }

  // Parse assets
  const declaredAssetUrls = new Set();
  const parsedAssets = [];

  for (const [urlKey, assetDef] of Object.entries(jsonObj.assets)) {
    const urlPattern = parseUrlPattern(urlKey, parsedParams);
    declaredAssetUrls.add(urlKey);

    checkKnownProperties(assetDef, ['path', 'content'], `asset ${urlKey}`);
    const hasPath = assetDef.path !== undefined;
    const hasContent = assetDef.content !== undefined;

    if ((hasPath && hasContent) || (!hasPath && !hasContent)) {
      throw new Error('Exactly one of these properties must be present: content, path.');
    }

    let buffer;
    let sourceDesc;
    if (hasPath) {
      if (typeof assetDef.path !== 'string') throw new Error('Expected string.');
      const filePath = path.isAbsolute(assetDef.path)
        ? assetDef.path
        : path.resolve(assetRoot, assetDef.path);
      buffer = fs.readFileSync(filePath);
      sourceDesc = assetDef.path;
    } else {
      if (typeof assetDef.content !== 'string') throw new Error('Expected string.');
      const dataUrl = parseDataUrl(assetDef.content);
      buffer = dataUrl.buffer;
      sourceDesc = assetDef.content.slice(0, 50);
    }

    const sha256Hex = crypto.createHash('sha256').update(buffer).digest('hex');
    const contentHash = `sha256:${sha256Hex}`;

    parsedAssets.push({
      urlPattern,
      urlKey,
      contentHash,
      buffer,
      sourceDesc
    });
  }

  // Parse platform if present
  let platform = {
    android: {},
    flutter: {},
    ios: { fonts: {} },
    web: {}
  };

  if (jsonObj.platform !== undefined) {
    checkKnownProperties(jsonObj.platform, ['android', 'flutter', 'ios', 'web'], 'platform');

    if (jsonObj.platform.android !== undefined) {
      checkKnownProperties(jsonObj.platform.android, [], 'platform.android');
    }
    if (jsonObj.platform.flutter !== undefined) {
      checkKnownProperties(jsonObj.platform.flutter, [], 'platform.flutter');
    }
    if (jsonObj.platform.web !== undefined) {
      checkKnownProperties(jsonObj.platform.web, [], 'platform.web');
    }
    if (jsonObj.platform.ios !== undefined) {
      checkKnownProperties(jsonObj.platform.ios, ['fonts'], 'platform.ios');
      if (jsonObj.platform.ios.fonts !== undefined) {
        checkKnownProperties(jsonObj.platform.ios.fonts, Object.keys(jsonObj.platform.ios.fonts), 'platform.ios.fonts');
        for (const [fontName, fontDef] of Object.entries(jsonObj.platform.ios.fonts)) {
          checkKnownProperties(fontDef, ['asset'], `font ${fontName}`);
          if (fontDef.asset === undefined) {
            throw new Error("Missing required property 'asset'.");
          }
          if (typeof fontDef.asset !== 'string') {
            throw new Error('Expected string.');
          }
          if (!declaredAssetUrls.has(fontDef.asset)) {
            throw new Error('Asset does not appear in the asset map.');
          }
          // Resolve font target asset contentHash
          const matchedAsset = parsedAssets.find(a => a.urlKey === fontDef.asset);
          platform.ios.fonts[fontName] = {
            content: matchedAsset.contentHash
          };
        }
      }
    }
  }

  return {
    version: '2',
    parameters: parsedParams,
    assets: parsedAssets,
    platform
  };
}

/**
 * Compare CookedUrlPattern for canonical sorting matching Rust's Ord.
 * Rust enum CookedUrlPattern:
 *   Variant 0: Template(Vec<CookedTemplateComponent>)
 *   Variant 1: Url(String)
 * Template variants sort before Url variants.
 */
function compareCookedUrlPatterns(a, b) {
  const isTemplateA = a.template !== undefined;
  const isTemplateB = b.template !== undefined;

  if (isTemplateA && !isTemplateB) return -1;
  if (!isTemplateA && isTemplateB) return 1;

  if (!isTemplateA && !isTemplateB) {
    return a.url.localeCompare(b.url);
  }

  // Both are templates: compare component lists lexicographically
  const compsA = a.template;
  const compsB = b.template;
  const minLen = Math.min(compsA.length, compsB.length);

  for (let i = 0; i < minLen; i++) {
    const ca = compsA[i];
    const cb = compsB[i];
    const isLitA = ca.literal !== undefined;
    const isLitB = cb.literal !== undefined;

    if (isLitA && !isLitB) return -1;
    if (!isLitA && isLitB) return 1;

    const valA = isLitA ? ca.literal : ca.param;
    const valB = isLitB ? cb.literal : cb.param;
    const cmp = valA.localeCompare(valB);
    if (cmp !== 0) return cmp;
  }
  return compsA.length - compsB.length;
}

/**
 * Compile parsed asset map into Canonical Cooked JSON
 */
function cookAssetMap(parsedMap) {
  // Invert assets: group URL patterns by contentHash
  const hashesMap = new Map();
  for (const asset of parsedMap.assets) {
    if (!hashesMap.has(asset.contentHash)) {
      hashesMap.set(asset.contentHash, []);
    }
    const patternEntry = asset.urlPattern.type === 'template'
      ? { template: asset.urlPattern.components }
      : { url: asset.urlPattern.url };
    hashesMap.get(asset.contentHash).push(patternEntry);
  }

  // Sort urlPattern lists and sort assetHashes keys
  const sortedHashes = Array.from(hashesMap.keys()).sort();
  const assetHashesObj = {};
  for (const h of sortedHashes) {
    const patterns = hashesMap.get(h);
    patterns.sort(compareCookedUrlPatterns);
    assetHashesObj[h] = { urlPattern: patterns };
  }

  // Build sorted parameters object
  const sortedParamKeys = Array.from(parsedMap.parameters.keys()).sort();
  const parametersObj = {};
  for (const k of sortedParamKeys) {
    const p = parsedMap.parameters.get(k);
    parametersObj[k] = {
      default: p.default,
      namespace: p.namespace,
      scope: 'document',
      type: 'string'
    };
  }

  // Build sorted fonts in ios platform
  const sortedFontNames = Object.keys(parsedMap.platform.ios.fonts || {}).sort();
  const sortedFonts = {};
  for (const fn of sortedFontNames) {
    sortedFonts[fn] = parsedMap.platform.ios.fonts[fn];
  }

  const platformObj = {
    android: {},
    flutter: {},
    ios: { fonts: sortedFonts },
    web: {}
  };

  // Top-level object in canonical order: assetHashes, parameters, platform, version
  const cookedObj = {
    assetHashes: assetHashesObj,
    parameters: parametersObj,
    platform: platformObj,
    version: '2'
  };

  const canonicalJson = JSON.stringify(cookedObj);
  return { cookedObj, canonicalJson };
}

/**
 * Compute the deterministic asset map hash ("sha256:<hex>")
 */
function generateAssetMapHash(canonicalJson) {
  const hashHex = crypto.createHash('sha256').update(canonicalJson, 'utf-8').digest('hex');
  return `sha256:${hashHex}`;
}

/**
 * Gzip a buffer with mtime = 0
 */
function gzipBuffer(buffer) {
  return zlib.gzipSync(buffer, { mtime: 0 });
}

/**
 * Create multipart form-data payload matching fullstory-asset-uploader
 */
function buildMultipartPayload(contentHash, gzippedContent) {
  const boundary = `---------------------------${crypto.randomBytes(16).toString('hex')}`;
  const crlf = '\r\n';

  const part1Header = `--${boundary}${crlf}Content-Disposition: form-data; name="contentHash"${crlf}${crlf}${contentHash}${crlf}`;
  const part2Header = `--${boundary}${crlf}Content-Disposition: form-data; name="content"; filename="${contentHash}"${crlf}Content-Type: application/gzip${crlf}${crlf}`;
  const footer = `${crlf}--${boundary}--${crlf}`;

  const payload = Buffer.concat([
    Buffer.from(part1Header, 'utf-8'),
    Buffer.from(part2Header, 'utf-8'),
    gzippedContent,
    Buffer.from(footer, 'utf-8')
  ]);

  return { boundary, payload };
}

/**
 * Perform HTTP/HTTPS POST request with retry logic
 */
function makeHttpRequest(urlStr, apiKey, boundary, bodyBuffer, maxRetries = 3) {
  const parsedUrl = new URL(urlStr);
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: {
      'user-agent': `fullstory-asset-uploader ${VERSION}`,
      'authorization': `Basic ${apiKey}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'accept': '*/*',
      'content-length': bodyBuffer.length
    }
  };

  return new Promise((resolve, reject) => {
    let attempt = 0;

    function execute() {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const resBody = Buffer.concat(chunks).toString('utf-8');
          resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, body: resBody });
        });
      });

      req.on('error', (err) => {
        if (attempt < maxRetries) {
          attempt++;
          process.stdout.write(`Retrying... Retry count: ${attempt - 1}\n`);
          setTimeout(execute, Math.pow(2, attempt) * 500);
        } else {
          reject(err);
        }
      });

      req.write(bodyBuffer);
      req.end();
    }

    execute();
  });
}

/**
 * Upload an asset map and all missing assets to FullStory
 */
async function uploadAssetMap({
  inputJson,
  assetRoot = process.cwd(),
  apiKey,
  server = DEFAULT_SERVER,
  onProgress = () => {}
}) {
  onProgress('step', '[1/5] Loading asset map...');
  const parsed = parseAssetMap(inputJson, assetRoot);

  onProgress('step', '[2/5] Reading asset metadata...');
  const { canonicalJson } = cookAssetMap(parsed);

  onProgress('step', '[3/5] Generating asset map hash...');
  const assetMapHash = generateAssetMapHash(canonicalJson);
  const gzippedMap = gzipBuffer(Buffer.from(canonicalJson, 'utf-8'));

  onProgress('step', '[4/5] Uploading new assets...');

  // Phase 1: Upload map to check status
  const uploadMapUrl = `${server.replace(/\/+$/, '')}/assets/v1/uploadMap`;
  const uploadAssetUrl = `${server.replace(/\/+$/, '')}/assets/v1/upload`;

  const mapPayload = buildMultipartPayload(assetMapHash, gzippedMap);
  let res = await makeHttpRequest(uploadMapUrl, apiKey, mapPayload.boundary, mapPayload.payload);

  if (res.statusCode === 200) {
    onProgress('info', 'Asset map is already present.');
    onProgress('step', '[5/5] Done.');
    return { assetMapHash, status: 'already_present' };
  } else if (res.statusCode === 201) {
    onProgress('info', 'No new assets found.');
    onProgress('step', '[5/5] Done.');
    return { assetMapHash, status: 'uploaded' };
  } else if (res.statusCode === 424) {
    onProgress('info', 'New assets found.');
    let missingHashes = [];
    try {
      const data = JSON.parse(res.body);
      missingHashes = data.missingAssetHashes || [];
    } catch (e) {
      throw new Error(`Failed to parse 424 response from server: ${res.body}`);
    }

    // Group parsed assets by contentHash to find missing assets to upload
    const assetByHash = new Map();
    for (const a of parsed.assets) {
      if (!assetByHash.has(a.contentHash)) {
        assetByHash.set(a.contentHash, a.buffer);
      }
    }

    // Phase 2: Upload missing assets
    for (const h of missingHashes) {
      const rawAssetBuf = assetByHash.get(h);
      if (!rawAssetBuf) {
        throw new Error(`Server requested missing asset hash ${h} not found in local map.`);
      }
      const gzippedAsset = gzipBuffer(rawAssetBuf);
      const assetPayload = buildMultipartPayload(h, gzippedAsset);
      const uploadRes = await makeHttpRequest(uploadAssetUrl, apiKey, assetPayload.boundary, assetPayload.payload);
      if (uploadRes.statusCode !== 200 && uploadRes.statusCode !== 201) {
        throw new Error(`Uploading asset failed: ${uploadRes.statusCode} ${uploadRes.statusMessage}`);
      }
    }

    // Phase 3: Finalize asset map upload
    res = await makeHttpRequest(uploadMapUrl, apiKey, mapPayload.boundary, mapPayload.payload);
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`Server responded with unexpected status: ${res.statusCode} ${res.statusMessage}.`);
    }

    onProgress('step', '[5/5] Done.');
    return { assetMapHash, status: 'uploaded' };
  } else {
    throw new Error(`Server responded with unexpected status: ${res.statusCode} ${res.statusMessage}.`);
  }
}

module.exports = {
  VERSION,
  DEFAULT_SERVER,
  parseParameterName,
  parseDataUrl,
  parseUrlPattern,
  parseAssetMap,
  cookAssetMap,
  generateAssetMapHash,
  gzipBuffer,
  buildMultipartPayload,
  uploadAssetMap
};
