const chalk = require("chalk");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const luxon = require("luxon");
const os = require("os");
const sacli = require("sacli");
const zlib = require("zlib");

const BW_FOLDER_NAME = "bwss";

const dir = process.cwd();

const cli = sacli.Command.new();

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

let bwSession;
const bw = (...args) => {
  console.info(
    chalk.dim(
      "+ bw" +
        args.map((a) => (a.length > 10 ? a.slice(0, 7) + "..." : a)).join(" ")
    )
  );
  try {
    return cp
      .execFileSync("bw", args, {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
        cwd: dir,
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

const runDiff = (fileA, fileB) => {
  cp.spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--word-diff=color", fileA, fileB],
    {
      stdio: "inherit",
      cwd: dir,
    }
  );
};

const UNLOCK_STDOUT_SESSION_LINE_PREFIX = "$ export BW_SESSION=";
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
bw("sync");
const bwFolderId = (() => {
  const f = bwJson("list", "folders").find((f) => f.name === BW_FOLDER_NAME);
  if (f) {
    return f.id;
  }
  return bwJson(
    "create",
    "folder",
    jsonb64({
      name: BW_FOLDER_NAME,
    })
  ).id;
})();

cli.subcommand("sync").action(() => {
  const localRemaining = new Set(fs.readdirSync(dir));
  const localEmpty = !localRemaining.size;
  if (localEmpty) {
    console.info("It looks like this is a new client");
  }

  const items = bwJson("list", "items", "--folderid", bwFolderId);
  for (const item of items) {
    const { id, name, notes, revisionDate } = item;
    localRemaining.delete(name);
    const upTs = luxon.DateTime.fromISO(revisionDate);
    const upData = decompress(Buffer.from(notes, "base64"));
    const upHash = hash(upData);
    const localStats = fs.lstatSync(name, { throwIfNoEntry: false });
    if (localStats && !localStats.isFile()) {
      console.error(name, "is not a file, will not process");
      continue;
    }
    const localData = localStats && fs.readFileSync(name);
    const localHash = localData && hash(localData);

    // One of {pull, push, deleteLocal, deleteRemote, skip}.
    let action = "skip";
    if (!localStats && localEmpty) {
      action = "pull";
    } else if (!localStats) {
      switch (
        confirm(
          `${name} does not exist locally, choose an action: [d]elete remote/[p]ull`
        )
      ) {
        case "d":
          action = "deleteRemote";
          break;
        case "p":
          action = "pull";
          break;
        default:
          console.error("Unknown choice, will skip");
          break;
      }
    } else if (upHash != localHash) {
      console.log(`${name} has changed:`);
      console.table({
        local: {
          hash: localHash.slice(0, 7),
          size: formatSize(localStats.size),
          modified: formatTs(luxon.DateTime.fromMillis(localStats.mtimeMs)),
        },
        remote: {
          hash: upHash.slice(0, 7),
          size: formatSize(upData.length),
          modified: formatTs(upTs),
        },
      });
      switch (confirm(`Choose an action: [p]ull/p[u]sh`)) {
        case "p":
          action = "pull";
          break;
        case "u":
          action = "push";
          break;
        default:
          console.error("Unknown choice, will skip");
          break;
      }
    }

    switch (action) {
      case "pull":
        console.info(`Pulling ${name}...`);
        fs.writeFileSync(name, upData);
        cp.execFileSync("touch", [
          "-t",
          upTs.toFormat("yyyyMMddHHmm.ss"),
          name,
        ]);
        break;
      case "push":
        console.info(`Pushing ${name}...`);
        bw(
          "edit",
          "item",
          id,
          jsonb64({
            ...item,
            notes: compress(localData).toString("base64"),
          })
        );
        break;
      case "deleteLocal":
        console.warn(chalk.red(`Deleting local ${name}...`));
        fs.unlinkSync(name);
        break;
      case "deleteRemote":
        console.warn(
          chalk.yellow(
            `Deleting remote ${name} (it can be recovered within 30 days)...`
          )
        );
        bw("delete", "item", id);
        break;
      case "skip":
        console.info(`Skipping ${name}...`);
        break;
    }
  }

  for (const f of localRemaining) {
    switch (
      confirm(
        `${f} does not exist remotely, choose an action: [d]elete local/p[u]sh`
      )
    ) {
      case "d":
        console.warn(chalk.red(`Deleting local ${f}...`));
        fs.unlinkSync(f);
        break;
      case "u":
        console.info(`Pushing ${f}...`);
        bw(
          "create",
          "item",
          jsonb64({
            type: 2,
            name: f,
            notes: compress(fs.readFileSync(f)).toString("base64"),
            secureNote: {
              type: 0,
            },
            folderId: bwFolderId,
          })
        );
        break;
      default:
        console.error("Unknown action, will skip");
        break;
    }
  }

  console.info(chalk.green("All done!"));
});

cli.eval(process.argv.slice(2));
