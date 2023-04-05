const chalk = require("chalk");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const luxon = require("luxon");
const zlib = require("zlib");

const jsonb64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

const compress = (raw) =>
  zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });

const decompress = (compressed) => zlib.brotliDecompressSync(compressed);

const hash = (bytes) => crypto.createHash("sha512").update(bytes).digest("hex");

const formatTs = (dt) =>
  dt.toLocaleString(luxon.DateTime.DATETIME_MED_WITH_WEEKDAY);

const formatSize = (bytes) => {
  let size = bytes;
  for (const suffix of ["", "K", "M"]) {
    if (size < 1024) {
      return `${Math.round(size * 100) / 100} ${suffix}B`;
    }
    size /= 100;
  }
  return "Too large for Bitwarden";
};

const bw = (...args) => {
  console.info(
    chalk.dim(
      "+ bw " +
        args.map((a) => (a.length > 10 ? a.slice(0, 7) + "..." : a)).join(" ")
    )
  );
  try {
    return cp
      .execFileSync("bw", args, {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
        env: {
          ...process.env,
          BW_SESSION: bwSession,
        },
      })
      .trim();
  } catch (e) {
    console.error(chalk.red("Command failed. Output from Bitwarden:"));
    console.error(e.output[1]);
    process.exit(1);
  }
};

let bwSession;
const UNLOCK_STDOUT_SESSION_LINE_PREFIX = "$ export BW_SESSION=";
// Put this after `bw` declaration as otherwise we'll get `Cannot access 'bw' before initialization`.
// Don't assign in declaration e.g. `const bwSession = (() => {...});` as this calls `bw` which references `bwSession`.
bwSession = (() => {
  if (process.env.BW_SESSION) {
    // TODO This value might be invalid/out of date.
    return process.env.BW_SESSION;
  }
  const out = bw("unlock");
  const line = out
    .split(os.EOL)
    .find((l) => l.startsWith(UNLOCK_STDOUT_SESSION_LINE_PREFIX));
  if (!line) {
    console.error(chalk.red("Session not found. Output from Bitwarden:"));
    console.error(out);
    process.exit(1);
  }
  return line.slice(UNLOCK_STDOUT_SESSION_LINE_PREFIX.length + 1, -1);
})();

const bwJson = (...args) => {
  const out = bw(...args);
  try {
    return JSON.parse(out);
  } catch (e) {
    console.error(
      chalk.red("Command did not output JSON. Output from Bitwarden:")
    );
    console.error(out);
    process.exit(1);
  }
};

const confirm = (q) => {
  process.stdout.write(chalk.inverse(q));
  process.stdout.write(" ");
  const response = Buffer.alloc(16);
  const responseLen = fs.readSync(0, response);
  return response.slice(0, responseLen).toString().trim().toLowerCase();
};

module.exports = {
  bw,
  bwJson,
  compress,
  confirm,
  decompress,
  formatSize,
  formatTs,
  hash,
  jsonb64,
};
