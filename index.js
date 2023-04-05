#!/usr/bin/env node

const chalk = require("chalk");
const cp = require("child_process");
const fs = require("fs");
const luxon = require("luxon");
const minimatch = require("minimatch");
const {
  bw,
  bwJson,
  compress,
  confirm,
  decompress,
  formatSize,
  formatTs,
  hash,
  jsonb64,
} = require("./util");

const BW_FOLDER_NAME = fs.existsSync(".bwss")
  ? fs.readFileSync(".bwss", "utf-8").trim()
  : "bwss";
if (!BW_FOLDER_NAME) {
  throw new Error(
    `.bwss file is empty; its contents is used as the Bitwarden folder name`
  );
}
console.info("Using folder name:", BW_FOLDER_NAME);

const ignorePatterns = fs.existsSync(".bwssignore")
  ? fs
      .readFileSync(".bwssignore", "utf-8")
      .split(/[\r\n]+/)
      .map((p) => p.trimEnd())
      .filter((l) => l && !l.startsWith("#"))
  : [];

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

const localRemaining = new Set(
  fs.readdirSync(".").filter((f) => {
    const st = fs.lstatSync(f);
    // We don't support folders.
    // We don't support symlinks as the user is unlikely to want to sync them, as they won't be symlinks once it's downloaded (on same or other device). It's possible the literal link path should be synced, but we don't support that.
    return (
      st.isFile() &&
      f != ".bwss" &&
      !ignorePatterns.some((p) => minimatch(f, p))
    );
  })
);
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
      fs.writeFileSync(name, upData, { mode: 0o400 });
      cp.execFileSync("touch", ["-t", upTs.toFormat("yyyyMMddHHmm.ss"), name]);
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
