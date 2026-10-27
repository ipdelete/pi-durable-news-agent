import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = join(dirname(fileURLToPath(import.meta.url)), "setup-wsl.sh");
const linux = { skip: process.platform !== "linux" };
const windows = { skip: process.platform !== "win32" };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dna-wsl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "Windows checkout");
  const target = join(root, "Linux checkout");
  mkdirSync(source);
  mkdirSync(target);
  return {
    source,
    target,
    run() {
      return spawnSync(
        "bash",
        ["-c", 'source "$1"; configure "$2" "$3"', "test", helper, source, target],
        {
          encoding: "utf8",
        },
      );
    },
  };
}

test(
  "copies only config privately and resolves Windows relative data paths without logging secrets",
  linux,
  (t) => {
    const f = fixture(t);
    writeFileSync(
      join(f.source, ".env"),
      "DNA_PROVIDER=github-copilot\r\nDNA_DATA_DIR=data\\copilot\r\nOPENROUTER_API_KEY=fixture-secret\r\n",
    );
    writeFileSync(join(f.source, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(readFileSync(join(f.target, ".env"), "utf8"));
    assert.equal(env.DNA_DATA_DIR, join(f.target, "data", "copilot"));
    assert.equal(env.OPENROUTER_API_KEY, "fixture-secret");
    assert.equal(statSync(join(f.target, ".env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.target, ".npmrc")).mode & 0o777, 0o600);
    assert.equal((result.stdout + result.stderr).includes("fixture-secret"), false);
  },
);

test("reruns preserve Linux credentials, registry, and an absolute data directory", linux, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, ".env"), "OPENROUTER_API_KEY=windows-value\n");
  writeFileSync(join(f.source, ".npmrc"), "registry=https://example.invalid/\n");
  writeFileSync(
    join(f.target, ".env"),
    "OPENROUTER_API_KEY=linux-value\nDNA_DATA_DIR=/keep/state\n",
  );
  writeFileSync(join(f.target, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  assert.equal(f.run().status, 0);
  const first = readFileSync(join(f.target, ".env"), "utf8");
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), first);
  assert.equal(parseEnv(first).OPENROUTER_API_KEY, "linux-value");
  assert.equal(parseEnv(first).DNA_DATA_DIR, "/keep/state");
  assert.equal(
    readFileSync(join(f.target, ".npmrc"), "utf8"),
    "registry=https://registry.npmjs.org/\n",
  );
});

test(
  "rejects absolute Windows data paths instead of creating misleading Linux state",
  linux,
  (t) => {
    const f = fixture(t);
    writeFileSync(join(f.source, ".env"), "DNA_DATA_DIR=C:\\state\\copilot\n");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Windows absolute path/);
  },
);

test("does not follow a config symlink", linux, (t) => {
  const f = fixture(t);
  const outside = join(f.source, ".env");
  writeFileSync(outside, "DNA_DATA_DIR=data\n");
  symlinkSync(outside, join(f.target, ".env"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  assert.equal(readFileSync(outside, "utf8"), "DNA_DATA_DIR=data\n");
});

test("refuses a different existing branch without changing the checkout", linux, (t) => {
  const f = fixture(t);
  for (const args of [
    ["init", "-q", "-b", "keep-this-branch", f.target],
    [
      "-C",
      f.target,
      "remote",
      "add",
      "origin",
      "https://github.com/ipdelete/pi-durable-news-agent.git",
    ],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(f.target, "local-work"), "preserve");
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; check_checkout "$2" "$3" "$4"',
      "test",
      helper,
      f.target,
      "https://github.com/ipdelete/pi-durable-news-agent.git",
      "feat/copilot-provider",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different branch/);
  assert.equal(readFileSync(join(f.target, "local-work"), "utf8"), "preserve");
  assert.equal(
    spawnSync("git", ["-C", f.target, "branch", "--show-current"], {
      encoding: "utf8",
    }).stdout.trim(),
    "keep-this-branch",
  );
});

test(
  "PowerShell invokes only system package installation as root and cleans its LF-only helper",
  windows,
  (t) => {
    const f = fixture(t);
    const scripts = join(f.source, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(f.source, ".env"), "DNA_PROVIDER=github-copilot\n");
    writeFileSync(
      join(scripts, "setup-wsl.ps1"),
      readFileSync(join(dirname(helper), "setup-wsl.ps1")),
    );
    writeFileSync(
      join(scripts, "setup-wsl.sh"),
      readFileSync(helper, "utf8").replace(/\r?\n/g, "\r\n"),
    );
    const script = join(scripts, "setup-wsl.ps1").replaceAll("'", "''");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `
    $ErrorActionPreference = 'Stop'
    $global:calls = @()
    $global:temporaryHelper = $null
    function global:wsl.exe {
      $global:calls += ,@($args)
      $global:LASTEXITCODE = 0
      if ($args -contains 'wslpath') {
        if (-not $global:temporaryHelper) {
          $global:temporaryHelper = $args[-1]
          if ([IO.File]::ReadAllText($global:temporaryHelper).Contains([string][char]13)) {
            throw 'Temporary helper contains CRLF'
          }
        }
        '/tmp/test helper'
      }
    }
    & '${script}' | Out-Null
    $rootCalls = @($global:calls | Where-Object { $_ -contains '--user' })
    if ($rootCalls.Count -ne 1 -or $rootCalls[0][-1] -ne 'packages') {
      throw 'Only the packages phase should use root'
    }
    if ($global:calls.Count -ne 5) { throw 'Unexpected WSL calls' }
    if (Test-Path -LiteralPath $global:temporaryHelper) { throw 'Temporary helper was not cleaned' }
  `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
