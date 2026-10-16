#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  VERSION,
  DEFAULT_SERVER,
  parseAssetMap,
  cookAssetMap,
  generateAssetMapHash,
  uploadAssetMap
} = require('../src/index');

function printHelp() {
  console.log(`fullstory-asset-uploader ${VERSION}
Work with and upload FullStory asset maps.

USAGE:
    fullstory-asset-uploader [OPTIONS] [SUBCOMMAND]

OPTIONS:
    -h, --help                   Print help information
    -j, --json                   Generate JSON output.
    -p, --parallel <parallel>    Maximum number of threads to use.
    -s, --silent                 Silence non-essential messages.
    -t, --text                   Generate text output. (Default.)
    -V, --version                Print version information

SUBCOMMANDS:
    generate    Generate the asset map ID for an asset map without uploading it.
    help        Print this message or the help of the given subcommand(s)
    upload      Upload an asset map and the assets it contains to FullStory.`);
}

function printGenerateHelp() {
  console.log(`fullstory-asset-uploader-generate 
Generate the asset map ID for an asset map without uploading it.

USAGE:
    fullstory-asset-uploader generate [OPTIONS] <ASSET MAP>

ARGS:
    <ASSET MAP>    The JSON asset map to generate an ID for, or '-' for stdin.

OPTIONS:
    -h, --help                       Print help information
    -j, --json                       Generate JSON output.
    -p, --parallel <parallel>        Maximum number of threads to use.
    -r, --asset-root <ASSET ROOT>    The directory containing the assets. Defaults to the directory
                                     containing the asset map, or the current working directory for
                                     stdin.
    -s, --silent                     Silence non-essential messages.
    -t, --text                       Generate text output. (Default.)`);
}

function printUploadHelp() {
  console.log(`fullstory-asset-uploader-upload 
Upload an asset map and the assets it contains to FullStory.

USAGE:
    fullstory-asset-uploader upload [OPTIONS] --api-key <KEY> <ASSET MAP>

ARGS:
    <ASSET MAP>    The JSON asset map to generate an ID for, or '-' for stdin.

OPTIONS:
    -h, --help                       Print help information
    -j, --json                       Generate JSON output.
    -k, --api-key <KEY>              A FullStory API key with Admin permissions. [env:
                                     FULLSTORY_API_KEY=]
    -p, --parallel <parallel>        Maximum number of threads to use.
    -r, --asset-root <ASSET ROOT>    The directory containing the assets. Defaults to the directory
                                     containing the asset map, or the current working directory for
                                     stdin.
    -s, --silent                     Silence non-essential messages.
        --server <SERVER>            The asset server to connect to. [env: FULLSTORY_ASSET_SERVER=]
    -t, --text                       Generate text output. (Default.)`);
}

async function readInput(assetMapArg) {
  if (assetMapArg === '-') {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
  } else {
    return fs.readFileSync(assetMapArg, 'utf-8');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    if (args.includes('generate')) {
      printGenerateHelp();
    } else if (args.includes('upload')) {
      printUploadHelp();
    } else {
      printHelp();
    }
    process.exit(0);
  }

  if (args.includes('-V') || args.includes('--version')) {
    console.log(`fullstory-asset-uploader ${VERSION}`);
    process.exit(0);
  }

  const subcommand = args[0];
  if (subcommand !== 'generate' && subcommand !== 'upload') {
    console.error(`error: Found argument '${subcommand}' which wasn't expected, or isn't valid in this context`);
    process.exit(1);
  }

  const subArgs = args.slice(1);
  let isJson = false;
  let isSilent = false;
  let assetRoot = null;
  let apiKey = process.env.FULLSTORY_API_KEY || null;
  let server = process.env.FULLSTORY_ASSET_SERVER || DEFAULT_SERVER;
  let parallel = null;
  let assetMapPath = null;

  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (a === '-h' || a === '--help') {
      if (subcommand === 'generate') printGenerateHelp();
      else printUploadHelp();
      process.exit(0);
    } else if (a === '-j' || a === '--json') {
      isJson = true;
    } else if (a === '-s' || a === '--silent') {
      isSilent = true;
    } else if (a === '-t' || a === '--text') {
      isJson = false;
    } else if (a === '-r' || a === '--asset-root') {
      assetRoot = subArgs[++i];
    } else if (a === '-k' || a === '--api-key') {
      apiKey = subArgs[++i];
    } else if (a === '--server') {
      server = subArgs[++i];
    } else if (a === '-p' || a === '--parallel') {
      parallel = parseInt(subArgs[++i], 10);
      if (isNaN(parallel) || parallel <= 0) {
        console.error(`Invalid --parallel option: '${subArgs[i]}' must be a positive integer.`);
        process.exit(1);
      }
    } else if (!a.startsWith('-') || a === '-') {
      assetMapPath = a;
    }
  }

  if (!assetMapPath) {
    console.error(`error: The following required arguments were not provided:\n    <ASSET MAP>`);
    process.exit(1);
  }

  if (subcommand === 'upload' && !apiKey) {
    console.error(`error: The following required arguments were not provided:\n    --api-key <KEY>`);
    process.exit(1);
  }

  if (!assetRoot) {
    if (assetMapPath === '-') {
      assetRoot = process.cwd();
    } else {
      assetRoot = path.dirname(path.resolve(assetMapPath));
    }
  }

  const onProgress = (type, msg) => {
    if (!isSilent) {
      if (type === 'step' || type === 'info') {
        process.stderr.write(`${msg}\n`);
      }
    }
  };

  try {
    const rawInput = await readInput(assetMapPath);
    let parsedJson;
    try {
      parsedJson = JSON.parse(rawInput);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }

    if (subcommand === 'generate') {
      onProgress('step', '[1/4] Loading asset map...');
      const parsedMap = parseAssetMap(parsedJson, assetRoot);
      onProgress('step', '[2/4] Reading asset metadata...');
      const { canonicalJson } = cookAssetMap(parsedMap);
      onProgress('step', '[3/4] Generating asset map hash...');
      const assetMapHash = generateAssetMapHash(canonicalJson);
      onProgress('step', '[4/4] Done.');

      if (isJson) {
        console.log(JSON.stringify({ assetMapHash }));
      } else {
        console.log(`\n${assetMapHash}\n`);
      }
    } else if (subcommand === 'upload') {
      const result = await uploadAssetMap({
        inputJson: parsedJson,
        assetRoot,
        apiKey,
        server,
        onProgress
      });

      if (isJson) {
        console.log(JSON.stringify({ assetMapHash: result.assetMapHash }));
      } else {
        console.log(result.assetMapHash);
      }
    }
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ error: err.message }));
    } else {
      console.error(`error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
