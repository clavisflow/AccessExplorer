(function () {
    const filePath = "/work/input.accdb";
    const wasmBasePath = "mdbtools/";
    let currentBytes = null;

    const commandMap = {
        "mdb-ver": "createMdbVerModule",
        "mdb-tables": "createMdbTablesModule",
        "mdb-schema": "createMdbSchemaModule",
        "mdb-count": "createMdbCountModule",
        "mdb-queries": "createMdbQueriesModule",
        "mdb-json": "createMdbJsonModule"
    };

    function toUint8Array(value) {
        if (value instanceof Uint8Array) {
            return value;
        }

        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }

        return Uint8Array.from(value);
    }

    function lines(output) {
        return output
            .map(line => String(line).trim())
            .filter(line => line.length > 0);
    }

    async function runCommand(command, bytes, args, options) {
        const stdout = [];
        const stderr = [];
        const startedAt = performance.now();
        const factoryName = commandMap[command];
        const factory = globalThis[factoryName];
        if (typeof factory !== "function") {
            throw new Error(`${factoryName} is not loaded.`);
        }

        const module = await factory({
            print: value => {
                const text = String(value);
                if (typeof options?.onStdout === "function") {
                    options.onStdout(text);
                } else {
                    stdout.push(text);
                }
            },
            printErr: value => stderr.push(String(value)),
            locateFile: fileName => `${wasmBasePath}${fileName}`
        });

        try {
            module.FS.mkdir("/work");
        } catch {
            // The directory can already exist in the module instance.
        }

        module.FS.writeFile(filePath, bytes);

        const commandArgs = args.includes("{file}")
            ? args.map(arg => arg === "{file}" ? filePath : arg)
            : [...args, filePath];

        try {
            module.callMain(commandArgs);
        } catch {
            // Emscripten uses exceptions for process exits. stderr carries command failures.
        }

        return {
            command,
            elapsedMs: Math.round(performance.now() - startedAt),
            stdout,
            stderr
        };
    }

    function ensureCurrentBytes() {
        if (!currentBytes) {
            throw new Error("Access file data is not loaded. Please analyze a file first.");
        }

        return currentBytes;
    }

    async function tableNames(bytes, type) {
        const result = await runCommand("mdb-tables", bytes, ["-1", "-t", type]);
        return { names: lines(result.stdout), diagnostic: result };
    }

    function parseNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function parseObjectCatalog(output) {
        return output
            .map(line => {
                try {
                    const item = JSON.parse(line);
                    const name = String(item.Name ?? "").trim();
                    if (!name) {
                        return null;
                    }

                    return {
                        name,
                        typeCode: parseNumber(item.Type),
                        flags: parseNumber(item.Flags),
                        dateCreate: String(item.DateCreate ?? "").trim(),
                        dateUpdate: String(item.DateUpdate ?? "").trim()
                    };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    function hasSystemTablePermissionError(stderrLines) {
        const text = stderrLines.join("\n").toLowerCase();
        return text.includes("permission")
            || text.includes("access is denied")
            || text.includes("not authorized")
            || text.includes("could not open table")
            || text.includes("msysobjects");
    }

    function parseJsonRows(output) {
        return output
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(row => row && typeof row === "object" && !Array.isArray(row));
    }

    function displayValue(value) {
        if (value === null || value === undefined) {
            return "";
        }

        if (typeof value === "object") {
            if (typeof value.$binary === "string") {
                return `[binary ${value.$binary.length} chars]`;
            }

            return JSON.stringify(value);
        }

        return String(value);
    }

    function collectColumns(rows) {
        const columns = [];
        const seen = new Set();
        for (const row of rows) {
            for (const column of Object.keys(row)) {
                if (!seen.has(column)) {
                    seen.add(column);
                    columns.push(column);
                }
            }
        }

        return columns;
    }

    function toPreviewRows(rows) {
        return rows.map(row => Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, displayValue(value)])));
    }

    function csvValue(value) {
        const text = displayValue(value);
        return /[",\r\n]/.test(text)
            ? `"${text.replaceAll("\"", "\"\"")}"`
            : text;
    }

    function downloadBlob(fileName, content, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("\"", "&quot;")
            .replaceAll("'", "&#39;");
    }

    function formatNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString("ja-JP") : "-";
    }

    function formatBytes(value) {
        const bytes = Number(value);
        if (!Number.isFinite(bytes)) {
            return "-";
        }

        const megabytes = bytes / 1024 / 1024;
        return megabytes >= 1024
            ? `${(megabytes / 1024).toLocaleString("ja-JP", { maximumFractionDigits: 2 })} GB`
            : `${megabytes.toLocaleString("ja-JP", { maximumFractionDigits: 2 })} MB`;
    }

    function columnType(column) {
        return column?.size === null || column?.size === undefined
            ? column?.dataType ?? ""
            : `${column.dataType}(${column.size})`;
    }

    function renderList(items, itemRenderer) {
        if (!items || items.length === 0) {
            return "<p class=\"muted\">なし</p>";
        }

        return `<ul>${items.map(item => `<li>${itemRenderer(item)}</li>`).join("")}</ul>`;
    }

    function renderObjectTable(title, items) {
        const rows = (items ?? []).map(item => `
            <tr>
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.dateCreate ?? "")}</td>
                <td>${escapeHtml(item.dateUpdate ?? "")}</td>
                <td>${escapeHtml(item.typeCode ?? "")}</td>
                <td>${escapeHtml(item.flags ?? "")}</td>
            </tr>`).join("");

        return `
            <section class="section">
                <h2>${escapeHtml(title)}</h2>
                <p class="section-note">${formatNumber((items ?? []).length)} 件</p>
                ${rows
                    ? `<table><thead><tr><th>名前</th><th>作成日</th><th>更新日</th><th>Type</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table>`
                    : "<p class=\"muted\">なし</p>"}
            </section>`;
    }

    function buildHtmlReport(data) {
        const generatedAt = new Date().toLocaleString("ja-JP");
        const summary = data.summary ?? {};
        const tables = data.tables ?? [];
        const queries = data.queries ?? [];
        const objects = data.objects ?? {};
        const orderedTables = [...tables]
            .sort((a, b) => Number(b.recordCount ?? -1) - Number(a.recordCount ?? -1) || String(a.name).localeCompare(String(b.name), "ja"));

        const tableRows = tables.map(table => `
            <section class="table-spec">
                <h3>${escapeHtml(table.name)}</h3>
                <dl>
                    <div><dt>レコード数</dt><dd>${formatNumber(table.recordCount)}</dd></div>
                    <div><dt>列数</dt><dd>${formatNumber((table.columns ?? []).length)}</dd></div>
                    <div><dt>インデックス</dt><dd>${formatNumber((table.indexes ?? []).length)}</dd></div>
                    <div><dt>制約</dt><dd>${formatNumber((table.constraints ?? []).length)}</dd></div>
                </dl>
                <table>
                    <thead><tr><th>列名</th><th>型</th><th>必須</th></tr></thead>
                    <tbody>
                        ${(table.columns ?? []).map(column => `
                            <tr>
                                <td>${escapeHtml(column.name)}</td>
                                <td>${escapeHtml(columnType(column))}</td>
                                <td>${column.isNotNull ? "Yes" : ""}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
                <div class="subgrid">
                    <section>
                        <h4>インデックス</h4>
                        ${renderList(table.indexes ?? [], index => `${escapeHtml(index.name)} (${escapeHtml((index.columns ?? []).join(", "))})${index.isPrimaryKey ? " [PK]" : ""}${index.isUnique ? " [UNIQUE]" : ""}`)}
                    </section>
                    <section>
                        <h4>制約</h4>
                        ${renderList(table.constraints ?? [], constraint => `${escapeHtml(constraint.kind)}: ${escapeHtml(constraint.name)} ${escapeHtml(constraint.definition)}`)}
                    </section>
                </div>
            </section>`).join("");

        const queryRows = queries.map(query => `
            <tr>
                <td>${escapeHtml(query.name)}</td>
                <td>${escapeHtml(query.kind)}</td>
                <td><pre>${escapeHtml(query.sqlCaptured ? query.sql : "初期解析では未取得")}</pre></td>
            </tr>`).join("");

        return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(data.fileName)} - Access解析レポート</title>
<style>
:root{--text:#17202a;--muted:#607080;--border:#d6dde6;--soft:#f6f8fb;--ink:#111827;--blue:#2364aa}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--text);font-family:"Yu Gothic UI","Meiryo","Segoe UI",Arial,sans-serif;line-height:1.55}
.page{max-width:1120px;margin:0 auto;padding:32px 28px 48px}
header{padding:24px 0 18px;border-bottom:3px solid var(--ink)}
.eyebrow{margin:0 0 8px;color:var(--muted);font-size:.82rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
h1{margin:0 0 10px;color:var(--ink);font-size:1.9rem;line-height:1.25;overflow-wrap:anywhere}
h2{margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border);font-size:1.25rem}
h3{margin:0 0 10px;font-size:1.08rem;overflow-wrap:anywhere}
h4{margin:0 0 8px;font-size:.95rem}
.meta{display:flex;flex-wrap:wrap;gap:10px 20px;margin:0;color:var(--muted)}
.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:22px 0}
.metric{padding:12px;border:1px solid var(--border);background:var(--soft)}
.metric span{display:block;color:var(--muted);font-size:.78rem;font-weight:700}
.metric strong{display:block;margin-top:4px;font-size:1.35rem}
.section{margin-top:28px}
.section-note{margin:0 0 10px;color:var(--muted)}
table{width:100%;table-layout:fixed;border-collapse:collapse;margin:10px 0 0;font-size:.88rem}
th,td{padding:8px 9px;border:1px solid var(--border);vertical-align:top;text-align:left}
td{overflow-wrap:anywhere;word-break:break-word}
th{background:var(--soft);color:#394858}
pre{margin:0;max-height:220px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow:auto;font-family:Consolas,"Courier New",monospace;font-size:.82rem}
.query-table th:nth-child(1){width:28%}
.query-table th:nth-child(2){width:14%}
.query-table th:nth-child(3){width:58%}
.table-spec{margin-top:18px;padding:14px;border:1px solid var(--border);break-inside:avoid}
dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 10px}
dl div{padding:8px;background:var(--soft);border:1px solid var(--border)}
dt{color:var(--muted);font-size:.76rem;font-weight:700}
dd{margin:2px 0 0;font-weight:700}
.subgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
ul{margin:0;padding-left:20px}
li{margin:3px 0;overflow-wrap:anywhere}
.muted{margin:0;color:var(--muted)}
@media print{.page{max-width:none;padding:18mm}pre{max-height:none}.table-spec{page-break-inside:avoid}}
@media (max-width:760px){.summary,dl,.subgrid{grid-template-columns:1fr}.page{padding:20px 14px}}
</style>
</head>
<body>
<main class="page">
<header>
    <p class="eyebrow">Access解析レポート</p>
    <h1>${escapeHtml(data.fileName)}</h1>
    <p class="meta">
        <span>生成日時: ${escapeHtml(generatedAt)}</span>
        <span>Access: ${escapeHtml(data.accessVersion)}</span>
        <span>ファイルサイズ: ${escapeHtml(formatBytes(data.fileSizeBytes))}</span>
    </p>
</header>

<section class="summary">
    <div class="metric"><span>テーブル</span><strong>${formatNumber(summary.tableCount)}</strong></div>
    <div class="metric"><span>総レコード数</span><strong>${formatNumber(summary.totalRecordCount)}</strong></div>
    <div class="metric"><span>クエリ</span><strong>${formatNumber(summary.queryCount)}</strong></div>
    <div class="metric"><span>フォーム/レポート</span><strong>${formatNumber(summary.formCount)} / ${formatNumber(summary.reportCount)}</strong></div>
    <div class="metric"><span>マクロ</span><strong>${formatNumber(summary.macroCount)}</strong></div>
    <div class="metric"><span>モジュール</span><strong>${formatNumber(summary.moduleCount)}</strong></div>
    <div class="metric"><span>リレーション</span><strong>${formatNumber(summary.relationshipCount)}</strong></div>
    <div class="metric"><span>リンクテーブル</span><strong>${formatNumber(summary.linkedTableCount)}</strong></div>
</section>

<section class="section">
    <h2>テーブル一覧</h2>
    <table><thead><tr><th>テーブル名</th><th>レコード数</th><th>列数</th></tr></thead><tbody>
        ${orderedTables.map(table => `<tr><td>${escapeHtml(table.name)}</td><td>${formatNumber(table.recordCount)}</td><td>${formatNumber((table.columns ?? []).length)}</td></tr>`).join("")}
    </tbody></table>
</section>

<section class="section">
    <h2>テーブル仕様</h2>
    ${tableRows || "<p class=\"muted\">なし</p>"}
</section>

<section class="section">
    <h2>クエリ仕様</h2>
    ${queryRows ? `<table class="query-table"><thead><tr><th>クエリ名</th><th>種別</th><th>SQL</th></tr></thead><tbody>${queryRows}</tbody></table>` : "<p class=\"muted\">なし</p>"}
</section>

${renderObjectTable("フォーム", objects.forms)}
${renderObjectTable("レポート", objects.reports)}
${renderObjectTable("マクロ", objects.macros)}
${renderObjectTable("モジュール", objects.modules)}
${renderObjectTable("リレーション", objects.relationships)}
${renderObjectTable("リンクテーブル", objects.linkedTables)}
</main>
</body>
</html>`;
    }

    window.accessDoctorMdb = {
        async analyzeAccessFile(fileBytes, options) {
            const bytes = toUint8Array(fileBytes);
            currentBytes = bytes;
            const diagnostics = [];

            const versionResult = await runCommand("mdb-ver", bytes, []);
            diagnostics.push(versionResult);

            const tablesResult = await tableNames(bytes, "table");
            const queriesResult = await tableNames(bytes, "query");
            const formsResult = await tableNames(bytes, "form");
            const reportsResult = await tableNames(bytes, "report");
            const macrosResult = await tableNames(bytes, "macro");
            const modulesResult = await tableNames(bytes, "module");
            const relationshipsResult = await tableNames(bytes, "relationship");
            const linkedTablesResult = await tableNames(bytes, "linkedtable");
            diagnostics.push(
                tablesResult.diagnostic,
                queriesResult.diagnostic,
                formsResult.diagnostic,
                reportsResult.diagnostic,
                macrosResult.diagnostic,
                modulesResult.diagnostic,
                relationshipsResult.diagnostic,
                linkedTablesResult.diagnostic);

            let objectDetails = [];
            const objectCatalogResult = await runCommand("mdb-json", bytes, ["{file}", "MSysObjects"]);
            diagnostics.push(objectCatalogResult);
            if (!hasSystemTablePermissionError(objectCatalogResult.stderr)) {
                objectDetails = parseObjectCatalog(objectCatalogResult.stdout);
            }

            const schemaResult = await runCommand("mdb-schema", bytes, []);
            diagnostics.push(schemaResult);

            const queryListResult = await runCommand("mdb-queries", bytes, ["-1"]);
            diagnostics.push(queryListResult);
            const queryNames = lines(queryListResult.stdout).length > 0
                ? lines(queryListResult.stdout)
                : queriesResult.names;

            const tableCounts = [];
            for (const tableName of tablesResult.names) {
                const countResult = await runCommand("mdb-count", bytes, ["{file}", tableName]);
                diagnostics.push(countResult);
                tableCounts.push({
                    tableName,
                    count: lines(countResult.stdout)[0] ?? "",
                    stderr: countResult.stderr.join("\n")
                });
            }

            const maxQuerySql = Number(options?.maxQuerySql ?? 30);
            const largeFileQuerySql = Number(options?.largeFileQuerySql ?? 5);
            const largeFileBytes = Number(options?.largeFileBytes ?? 104857600);
            const querySqlLimit = bytes.byteLength >= largeFileBytes
                ? Math.min(maxQuerySql, largeFileQuerySql)
                : Math.min(maxQuerySql, queryNames.length);
            const querySql = [];

            for (const queryName of queryNames.slice(0, querySqlLimit)) {
                const sqlResult = await runCommand("mdb-queries", bytes, ["{file}", queryName]);
                diagnostics.push(sqlResult);
                querySql.push({
                    queryName,
                    sql: sqlResult.stdout.join("\n"),
                    stderr: sqlResult.stderr.join("\n")
                });
            }

            return {
                version: lines(versionResult.stdout)[0] ?? "",
                tables: tablesResult.names,
                queries: queryNames,
                forms: formsResult.names,
                reports: reportsResult.names,
                macros: macrosResult.names,
                modules: modulesResult.names,
                relationships: relationshipsResult.names,
                linkedTables: linkedTablesResult.names,
                objectDetails,
                schema: schemaResult.stdout.join("\n"),
                tableCounts,
                querySql,
                commandDiagnostics: diagnostics.map(item => ({
                    command: item.command,
                    elapsedMs: item.elapsedMs,
                    stderr: item.stderr
                }))
            };
        },

        async readTablePreview(tableName, displayLimit) {
            const bytes = ensureCurrentBytes();
            const maxRows = Math.max(1, Number(displayLimit ?? 50));
            const commandLimit = maxRows + 1;
            const result = await runCommand("mdb-json", bytes, ["--limit", String(commandLimit), "{file}", tableName]);
            const parsedRows = parseJsonRows(result.stdout);
            const previewRows = parsedRows.slice(0, maxRows);

            return {
                columns: collectColumns(previewRows),
                rows: toPreviewRows(previewRows),
                displayLimit: maxRows,
                isTruncated: parsedRows.length > maxRows,
                diagnostic: {
                    command: result.command,
                    elapsedMs: result.elapsedMs,
                    stderr: result.stderr
                }
            };
        },

        async downloadTableCsv(fileName, tableName, columns) {
            const bytes = ensureCurrentBytes();
            const columnNames = Array.isArray(columns)
                ? columns.map(column => String(column)).filter(column => column.length > 0)
                : [];
            const csvLines = [];

            if (columnNames.length > 0) {
                csvLines.push(columnNames.map(csvValue).join(","));

                await runCommand("mdb-json", bytes, ["{file}", tableName], {
                    onStdout: line => {
                        const row = JSON.parse(line);
                        csvLines.push(columnNames.map(column => csvValue(row[column])).join(","));
                    }
                });
            } else {
                const result = await runCommand("mdb-json", bytes, ["{file}", tableName]);
                const rows = parseJsonRows(result.stdout);
                const inferredColumns = collectColumns(rows);
                csvLines.push(inferredColumns.map(csvValue).join(","));
                for (const row of rows) {
                    csvLines.push(inferredColumns.map(column => csvValue(row[column])).join(","));
                }
            }

            downloadBlob(fileName, `\uFEFF${csvLines.join("\r\n")}\r\n`, "text/csv;charset=utf-8");
        },

        downloadJson(fileName, data) {
            downloadBlob(fileName, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
        },

        downloadHtmlReport(fileName, data) {
            downloadBlob(fileName, buildHtmlReport(data), "text/html;charset=utf-8");
        }
    };

    document.documentElement.dataset.accessDoctorMdb = "ready";
    document.documentElement.dataset.accessDoctorMdbFactories = Object.values(commandMap)
        .every(factoryName => typeof globalThis[factoryName] === "function")
        ? "ready"
        : "missing";
})();
