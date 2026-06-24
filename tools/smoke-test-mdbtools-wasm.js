const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const sampleDir = path.join(rootDir, 'sample');
const wasmDir = path.join(rootDir, '.spike', 'wasm-artifacts');
const outRoot = path.join(rootDir, '.spike', 'sample-results');

function accessFiles() {
  return fs.readdirSync(sampleDir)
    .filter(name => /\.(mdb|accdb)$/i.test(name))
    .map(name => {
      const fullPath = path.join(sampleDir, name);
      return { name, fullPath, size: fs.statSync(fullPath).size };
    })
    .sort((a, b) => a.size - b.size);
}

async function runMdbCommand(command, file, args) {
  const create = require(path.join(wasmDir, `${command}.js`));
  const stdout = [];
  const stderr = [];
  const module = await create({
    print: value => stdout.push(String(value)),
    printErr: value => stderr.push(String(value)),
    locateFile: fileName => path.join(wasmDir, fileName),
  });

  try {
    module.FS.mkdir('/work');
  } catch {
    // Directory already exists in this module instance.
  }

  module.FS.writeFile('/work/input.accdb', new Uint8Array(fs.readFileSync(file.fullPath)));

  const startedAt = Date.now();
  const commandArgs = args.includes('{file}')
    ? args.map(arg => arg === '{file}' ? '/work/input.accdb' : arg)
    : [...args, '/work/input.accdb'];

  try {
    module.callMain(commandArgs);
  } catch {
    // Emscripten uses exceptions for process exit; stderr captures command failures.
  }

  return {
    command,
    args,
    elapsedMs: Date.now() - startedAt,
    stdout,
    stderr,
  };
}

function safeDirectoryName(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '_');
}

function writeCommandOutput(outDir, result) {
  const suffix = result.args.length > 0
    ? result.args.map(arg => arg.replace(/^-+/, '')).join('_')
    : 'default';
  const baseName = `${result.command}-${suffix}`;
  fs.writeFileSync(path.join(outDir, `${baseName}.stdout.txt`), result.stdout.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, `${baseName}.stderr.txt`), result.stderr.join('\n'), 'utf8');
}

function nonEmptyLines(lines) {
  return lines.map(line => line.trim()).filter(Boolean);
}

async function countTables(file, tableNames) {
  const results = [];

  for (const tableName of tableNames) {
    const result = await runMdbCommand('mdb-count', file, ['{file}', tableName]);
    results.push({
      tableName,
      count: nonEmptyLines(result.stdout)[0] ?? '',
      stderr: result.stderr.join('\n'),
      elapsedMs: result.elapsedMs,
    });
  }

  return results;
}

async function analyzeFile(file) {
  const outDir = path.join(outRoot, safeDirectoryName(file.name));
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  results.push(await runMdbCommand('mdb-ver', file, []));
  results.push(await runMdbCommand('mdb-tables', file, ['-1']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'query']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'form']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'report']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'macro']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'module']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'relationship']));
  results.push(await runMdbCommand('mdb-tables', file, ['-1', '-t', 'linkedtable']));
  results.push(await runMdbCommand('mdb-schema', file, []));
  results.push(await runMdbCommand('mdb-queries', file, ['-1']));

  for (const result of results) {
    writeCommandOutput(outDir, result);
  }

  const tables = nonEmptyLines(results.find(result => result.command === 'mdb-tables' && result.args.join(' ') === '-1').stdout);
  const counts = await countTables(file, tables);
  fs.writeFileSync(path.join(outDir, 'table-counts.json'), JSON.stringify(counts, null, 2), 'utf8');

  const queryNames = nonEmptyLines(results[10].stdout);
  const querySqlProbe = [];
  for (const queryName of queryNames.slice(0, 5)) {
    const result = await runMdbCommand('mdb-queries', file, ['{file}', queryName]);
    querySqlProbe.push({
      queryName,
      sql: result.stdout.join('\n'),
      stderr: result.stderr.join('\n'),
      elapsedMs: result.elapsedMs,
    });
  }
  fs.writeFileSync(path.join(outDir, 'query-sql-probe.json'), JSON.stringify(querySqlProbe, null, 2), 'utf8');

  const summary = {
    fileName: file.name,
    fileSizeBytes: file.size,
    version: nonEmptyLines(results[0].stdout)[0] ?? '',
    tableCount: tables.length,
    queryCount: nonEmptyLines(results[2].stdout).length,
    formCount: nonEmptyLines(results[3].stdout).length,
    reportCount: nonEmptyLines(results[4].stdout).length,
    macroCount: nonEmptyLines(results[5].stdout).length,
    moduleCount: nonEmptyLines(results[6].stdout).length,
    relationshipCount: nonEmptyLines(results[7].stdout).length,
    linkedTableCount: nonEmptyLines(results[8].stdout).length,
    schemaLineCount: results[9].stdout.length,
    queriesLineCount: results[10].stdout.length,
    querySqlProbeCount: querySqlProbe.length,
    stderrLineCount: results.reduce((sum, result) => sum + result.stderr.length, 0) +
      counts.filter(count => count.stderr).length +
      querySqlProbe.filter(query => query.stderr).length,
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

async function main() {
  if (!fs.existsSync(wasmDir)) {
    throw new Error(`Missing WASM artifacts: ${wasmDir}`);
  }

  fs.mkdirSync(outRoot, { recursive: true });

  const summaries = [];
  for (const file of accessFiles()) {
    console.log(`Analyzing ${file.name} (${file.size} bytes)`);
    summaries.push(await analyzeFile(file));
  }

  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summaries, null, 2), 'utf8');
  console.table(summaries);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
