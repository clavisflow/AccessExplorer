# MDB Tools WASM spike

## Result

MDB Tools can be built with Emscripten in the current environment by using the official `emscripten/emsdk` Docker image.

Verified on 2026-06-24:

- `autoreconf` succeeds after normalizing CRLF line endings in the Windows clone.
- `emconfigure ./configure` succeeds with GLib, iconv, man pages, and bash completion disabled.
- `emmake make` succeeds.
- The following browser/Node friendly module wrappers were generated:
  - `mdb-tables.js` / `mdb-tables.wasm`
  - `mdb-schema.js` / `mdb-schema.wasm`
  - `mdb-count.js` / `mdb-count.wasm`
  - `mdb-queries.js` / `mdb-queries.wasm`
  - `mdb-json.js` / `mdb-json.wasm`
  - `mdb-ver.js` / `mdb-ver.wasm`
- `mdb-tables` and `mdb-schema` module wrappers were loaded from Node and `callMain(["--help"])` executed successfully.
- The wrappers now use `-sINVOKE_RUN=0` so commands run only when JavaScript calls `module.callMain(...)`.

The current generated artifacts are in `.spike/wasm-artifacts`. That directory is intentionally ignored because it is a disposable spike output.

## Reproduce

Run from the AccessDoctor repository root:

```powershell
.\tools\build-mdbtools-wasm.ps1
```

The script uses Docker and writes generated files to `.spike/wasm-artifacts`.

## Configure flags

```bash
emconfigure ./configure \
  --host=wasm32-unknown-emscripten \
  --disable-shared \
  --enable-static \
  --disable-glib \
  --disable-iconv \
  --disable-man \
  --with-bash-completion-dir=no
```

Important notes:

- `--disable-glib` avoids a GLib WASM dependency and uses MDB Tools' internal compatibility layer.
- `--disable-iconv` keeps the spike simple, but Japanese text handling must be tested carefully.
- SQL support remained enabled because flex and bison were installed in the Docker container.

## JavaScript usage shape

The relinked modules use:

```bash
-sMODULARIZE=1
-sENVIRONMENT=web,worker,node
-sINVOKE_RUN=0
-sALLOW_MEMORY_GROWTH=1
-sFORCE_FILESYSTEM=1
-sEXPORTED_RUNTIME_METHODS=FS,callMain
```

Expected Blazor integration shape:

```text
Blazor C#
  -> JS interop
  -> createMdbTablesModule()
  -> module.FS.writeFile("/work/input.accdb", bytes)
  -> module.callMain(["-1", "-T", "/work/input.accdb"])
  -> captured stdout/stderr
```

## Remaining validation

This spike only proves that MDB Tools can be compiled to WASM and launched. It does not yet prove Access diagnostic quality.

Next validation needs real `.mdb` / `.accdb` files with:

- Japanese table and column names
- local tables
- linked tables
- queries
- forms
- reports
- macros
- modules
- relationships

Minimum commands to validate against those files:

```text
mdb-ver
mdb-tables -1 -T
mdb-schema
mdb-count <table>
mdb-queries
mdb-json <table>
```

Risk areas:

- `.accdb` coverage may be weaker than `.mdb`.
- Japanese text may need iconv or another decoding strategy.
- encrypted/password-protected Access files are likely out of scope for pure WASM.
- form, report, macro, and VBA internals should still be treated as best-effort only.

## Sample validation

Run from the AccessDoctor repository root:

```powershell
node .\tools\smoke-test-mdbtools-wasm.js
```

The script reads `sample/*.mdb` and `sample/*.accdb`, runs the generated WASM commands, and writes outputs to `.spike/sample-results`.

Validated sample files on 2026-06-24:

| File | Version | Tables | Queries | Forms | Reports | Macros | Modules | Relationships | Linked tables |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `【新】新個別報告書用データ作成_20250303.accdb` | ACE14 | 5 | 17 | 1 | 19 | 6 | 0 | 2 | 0 |
| `SI_check203.accdb` | ACE12 | 37 | 146 | 2 | 6 | 2 | 4 | 2 | 0 |

Confirmed:

- Japanese file names, table names, column names, and query SQL can be returned as UTF-8 from the Node/WASM wrapper.
- `mdb-schema` returns table and column definitions.
- `mdb-count` returns row counts for all detected tables in both sample files.
- `mdb-queries -1` returns newline-separated query names.
- `mdb-queries <file> <query name>` returns SQL text for individual queries.
- `mdb-json <file> MSysObjects` can read the Access catalog, but binary property fields are noisy and should be filtered before use in the app.

Output notes:

- `Get-Content` in PowerShell may display saved UTF-8 JSON with mojibake depending on console encoding. Reading the files explicitly as UTF-8 shows the content correctly.
- `mdb-tables -t report` and other object-type filters should be treated as MDB Tools' catalog classification. We still need to compare with the Access UI before claiming perfect form/report/macro/module parity.
