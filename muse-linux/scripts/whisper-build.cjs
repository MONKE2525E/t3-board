const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');

const VERSION = '1.9.5';
const SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz`;
const SOURCE_SHA256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const CMAKE_FLAGS = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DWHISPER_BUILD_IS_DEV=OFF',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_AVX=ON',
  '-DGGML_AVX2=ON',
  '-DGGML_F16C=ON',
  '-DGGML_FMA=ON',
  '-DGGML_SSE42=ON',
  '-DGGML_BMI2=ON',
  '-DGGML_AVX512=OFF',
  '-DGGML_OPENMP=OFF',
  '-DGGML_BLAS=OFF',
  '-DGGML_CUDA=OFF',
  '-DGGML_METAL=OFF',
  '-DGGML_VULKAN=OFF',
  '-DGGML_SYCL=OFF',
  '-DGGML_HIP=OFF',
  '-DGGML_OPENCL=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF',
  '-DWHISPER_COREML=OFF',
  '-DWHISPER_COMMON_FFMPEG=OFF',
];

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'native/bin');
const trackedLicense = path.join(root, 'native/WHISPER-LICENSE');
const dest = path.join(outDir, 'whisper-cli');
const cacheRoot = process.env.MUSE_WHISPER_CACHE || '/tmp/muse-port-d6c9/parity/packaging';
const rebuild = process.argv.includes('--rebuild') || process.env.MUSE_WHISPER_REBUILD === '1';

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', timeout: BUILD_TIMEOUT_MS, ...options });
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function archiveRoot(archive) {
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim().split('\n');
  if (!listing.length) throw new Error('Empty whisper.cpp archive');
  const prefix = listing[0].replace(/\/+$/, '').split('/')[0];
  if (!prefix || listing.some(entry => entry.split('/')[0] !== prefix || entry.includes('..') || path.isAbsolute(entry))) {
    throw new Error('Unsafe whisper.cpp archive layout');
  }
  return prefix;
}

async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Could not download whisper.cpp ${VERSION}`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) return callback(new Error('whisper.cpp archive too large'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const temp = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { mode: 0o600 }));
    if (hash.digest('hex') !== SOURCE_SHA256) throw new Error('whisper.cpp archive hash mismatch');
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

function copyLicense(sourceDir) {
  const license = path.join(sourceDir, 'LICENSE');
  if (!fs.existsSync(license)) throw new Error('whisper.cpp LICENSE is missing');
  fs.copyFileSync(license, trackedLicense);
  fs.copyFileSync(license, path.join(outDir, 'WHISPER-LICENSE'));
}

function copyBinary(built) {
  fs.copyFileSync(built, dest);
  fs.chmodSync(dest, 0o755);
  const info = execFileSync('file', [dest], { encoding: 'utf8' });
  if (!info.includes('ELF') || !info.includes('x86-64')) throw new Error('whisper-cli is not an x86_64 ELF executable');
}

async function ensureArchive() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, `whisper.cpp-${VERSION}.tar.gz`);
  const candidates = [archive, '/tmp/muse-port-d6c9/parity/packaging/whisper-v1.9.5.tar.gz'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && sha256File(candidate) === SOURCE_SHA256) {
      if (candidate !== archive) fs.copyFileSync(candidate, archive);
      return archive;
    }
  }
  await download(SOURCE_URL, archive);
  if (sha256File(archive) !== SOURCE_SHA256) throw new Error('whisper.cpp archive hash mismatch');
  return archive;
}

function extract(archive) {
  const sourceDir = process.env.MUSE_WHISPER_SRC || path.join(cacheRoot, `whisper.cpp-${VERSION}`);
  if (fs.existsSync(path.join(sourceDir, 'CMakeLists.txt')) && fs.existsSync(path.join(sourceDir, 'LICENSE'))) return sourceDir;
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
  const prefix = archiveRoot(archive);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-whisper-src-'));
  try {
    run('tar', ['-xzf', archive, '-C', staging]);
    const extracted = path.join(staging, prefix);
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.renameSync(extracted, sourceDir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return sourceDir;
}

function which(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return '';
}

function build(sourceDir) {
  const buildDir = process.env.MUSE_WHISPER_BUILD || path.join(cacheRoot, `whisper-build-${VERSION}`);
  fs.mkdirSync(buildDir, { recursive: true });
  const generator = which('ninja') ? ['-G', 'Ninja'] : [];
  run('cmake', ['-S', sourceDir, '-B', buildDir, ...generator, ...CMAKE_FLAGS]);
  const jobs = String(Math.max(1, Math.min(8, os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  run('cmake', ['--build', buildDir, '--target', 'whisper-cli', '-j', jobs]);
  const built = path.join(buildDir, 'bin/whisper-cli');
  if (!fs.existsSync(built)) throw new Error('cmake did not produce whisper-cli');
  return built;
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('whisper-cli builds on Linux x86_64.');
  fs.mkdirSync(outDir, { recursive: true });
  if (!rebuild && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    if (fs.existsSync(trackedLicense)) fs.copyFileSync(trackedLicense, path.join(outDir, 'WHISPER-LICENSE'));
    console.log('Using existing native/bin/whisper-cli (pass --rebuild to compile from pinned whisper.cpp v1.9.5).');
    return;
  }
  if (!which('cmake') || !which('cc') || !which('c++')) throw new Error('cmake, cc and c++ are required to build whisper-cli.');
  const archive = await ensureArchive();
  const sourceDir = extract(archive);
  copyLicense(sourceDir);
  copyBinary(build(sourceDir));
  console.log(`Built whisper-cli from official whisper.cpp v${VERSION}.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
