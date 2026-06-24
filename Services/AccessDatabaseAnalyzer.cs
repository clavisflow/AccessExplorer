using System.Text.RegularExpressions;
using AccessDoctor.Models;
using Microsoft.AspNetCore.Components.Forms;
using Microsoft.JSInterop;

namespace AccessDoctor.Services;

public sealed partial class AccessDatabaseAnalyzer(IJSRuntime jsRuntime)
{
    private const long MaxFileSize = 300L * 1024 * 1024;

    public async Task<AccessDiagnosticsResult> AnalyzeAsync(IBrowserFile file)
    {
        ValidateFile(file);

        await using var browserStream = file.OpenReadStream(MaxFileSize);
        using var memory = new MemoryStream();
        await browserStream.CopyToAsync(memory);

        var raw = await jsRuntime.InvokeAsync<RawAccessAnalysis>(
            "accessDoctorMdb.analyzeAccessFile",
            memory.ToArray(),
            new { maxQuerySql = 30, largeFileQuerySql = 5, largeFileBytes = 100 * 1024 * 1024 });

        var parsedTables = ParseSchema(raw.Schema);
        var counts = raw.TableCounts.ToDictionary(
            item => item.TableName,
            item => ParseCount(item.Count),
            StringComparer.OrdinalIgnoreCase);

        var tables = raw.Tables
            .Select(name => new AccessTableInfo(
                name,
                parsedTables.TryGetValue(name, out var columns) ? columns : [],
                counts.GetValueOrDefault(name)))
            .ToList();

        var sqlByQuery = raw.QuerySql
            .Where(item => !string.IsNullOrWhiteSpace(item.Sql))
            .ToDictionary(item => item.QueryName, item => item.Sql, StringComparer.OrdinalIgnoreCase);

        var queries = raw.Queries
            .Select(name =>
            {
                sqlByQuery.TryGetValue(name, out var sql);
                return new AccessQueryInfo(name, sql, DetectQueryKind(sql), !string.IsNullOrWhiteSpace(sql));
            })
            .ToList();

        var summary = new AccessObjectSummary(
            tables.Count,
            queries.Count,
            raw.Forms.Count,
            raw.Reports.Count,
            raw.Macros.Count,
            raw.Modules.Count,
            raw.Relationships.Count,
            raw.LinkedTables.Count,
            tables.Sum(table => table.RecordCount ?? 0),
            queries.Count(query => query.SqlCaptured));

        var objectDetails = raw.ObjectDetails
            .GroupBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);

        var objects = new AccessObjectInventory(
            BuildObjectDetails(raw.Forms, "フォーム", objectDetails),
            BuildObjectDetails(raw.Reports, "レポート", objectDetails),
            BuildObjectDetails(raw.Macros, "マクロ", objectDetails),
            BuildObjectDetails(raw.Modules, "モジュール", objectDetails),
            BuildObjectDetails(raw.Relationships, "リレーション", objectDetails),
            BuildObjectDetails(raw.LinkedTables, "リンクテーブル", objectDetails));

        return new AccessDiagnosticsResult
        {
            FileName = file.Name,
            FileSizeBytes = file.Size,
            AccessVersion = string.IsNullOrWhiteSpace(raw.Version) ? "Unknown" : raw.Version,
            Summary = summary,
            Tables = tables,
            Queries = queries,
            Objects = objects,
            SchemaText = raw.Schema,
            CommandDiagnostics = raw.CommandDiagnostics
                .Select(item => new CommandDiagnostic(item.Command, item.ElapsedMs, item.Stderr))
                .ToList()
        };
    }

    private static void ValidateFile(IBrowserFile file)
    {
        var extension = Path.GetExtension(file.Name);
        if (!extension.Equals(".accdb", StringComparison.OrdinalIgnoreCase) &&
            !extension.Equals(".mdb", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(".accdb または .mdb ファイルを選択してください。");
        }

        if (file.Size > MaxFileSize)
        {
            throw new InvalidOperationException("300MB 以下の Access ファイルを選択してください。");
        }
    }

    private static Dictionary<string, IReadOnlyList<AccessColumnInfo>> ParseSchema(string schemaText)
    {
        var tables = new Dictionary<string, IReadOnlyList<AccessColumnInfo>>(StringComparer.OrdinalIgnoreCase);
        string? currentTable = null;
        var columns = new List<AccessColumnInfo>();

        foreach (var rawLine in schemaText.Split('\n'))
        {
            var line = rawLine.Trim();
            var tableMatch = CreateTableRegex().Match(line);
            if (tableMatch.Success)
            {
                currentTable = tableMatch.Groups["name"].Value;
                columns = [];
                continue;
            }

            if (currentTable is not null && line == ");")
            {
                tables[currentTable] = columns;
                currentTable = null;
                columns = [];
                continue;
            }

            if (currentTable is null || string.IsNullOrWhiteSpace(line) || line == "(")
            {
                continue;
            }

            var columnMatch = ColumnRegex().Match(line.TrimEnd(','));
            if (!columnMatch.Success)
            {
                continue;
            }

            columns.Add(new AccessColumnInfo(
                columnMatch.Groups["name"].Value,
                columnMatch.Groups["type"].Value.Trim(),
                int.TryParse(columnMatch.Groups["size"].Value, out var size) ? size : null));
        }

        return tables;
    }

    private static long? ParseCount(string? value) =>
        long.TryParse(value, out var count) ? count : null;

    private static IReadOnlyList<AccessObjectDetail> BuildObjectDetails(
        IEnumerable<string> names,
        string kind,
        IReadOnlyDictionary<string, RawObjectDetail> details)
    {
        return names
            .Select(name =>
            {
                details.TryGetValue(name, out var detail);
                return new AccessObjectDetail(
                    name,
                    kind,
                    detail?.TypeCode,
                    NullIfWhiteSpace(detail?.DateCreate),
                    NullIfWhiteSpace(detail?.DateUpdate),
                    detail?.Flags);
            })
            .ToList();
    }

    private static string? NullIfWhiteSpace(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private static string DetectQueryKind(string? sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            return "未取得";
        }

        var normalized = sql.TrimStart().ToUpperInvariant();
        if (normalized.StartsWith("SELECT INTO", StringComparison.Ordinal))
        {
            return "MAKE TABLE";
        }

        var firstToken = normalized.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return firstToken switch
        {
            "SELECT" => "SELECT",
            "UPDATE" => "UPDATE",
            "DELETE" => "DELETE",
            "INSERT" => "INSERT",
            "TRANSFORM" => "CROSSTAB",
            _ => "OTHER"
        };
    }

    [GeneratedRegex(@"^CREATE TABLE \[(?<name>.+)\]$")]
    private static partial Regex CreateTableRegex();

    [GeneratedRegex(@"^\[(?<name>.+)\]\s+(?<type>.+?)(?:\s+\((?<size>\d+)\))?$")]
    private static partial Regex ColumnRegex();
}

public sealed class RawAccessAnalysis
{
    public string Version { get; set; } = string.Empty;
    public List<string> Tables { get; set; } = [];
    public List<string> Queries { get; set; } = [];
    public List<string> Forms { get; set; } = [];
    public List<string> Reports { get; set; } = [];
    public List<string> Macros { get; set; } = [];
    public List<string> Modules { get; set; } = [];
    public List<string> Relationships { get; set; } = [];
    public List<string> LinkedTables { get; set; } = [];
    public List<RawObjectDetail> ObjectDetails { get; set; } = [];
    public string Schema { get; set; } = string.Empty;
    public List<RawTableCount> TableCounts { get; set; } = [];
    public List<RawQuerySql> QuerySql { get; set; } = [];
    public List<RawCommandDiagnostic> CommandDiagnostics { get; set; } = [];
}

public sealed class RawTableCount
{
    public string TableName { get; set; } = string.Empty;
    public string Count { get; set; } = string.Empty;
    public string Stderr { get; set; } = string.Empty;
}

public sealed class RawQuerySql
{
    public string QueryName { get; set; } = string.Empty;
    public string Sql { get; set; } = string.Empty;
    public string Stderr { get; set; } = string.Empty;
}

public sealed class RawObjectDetail
{
    public string Name { get; set; } = string.Empty;
    public int? TypeCode { get; set; }
    public int? Flags { get; set; }
    public string DateCreate { get; set; } = string.Empty;
    public string DateUpdate { get; set; } = string.Empty;
}

public sealed class RawCommandDiagnostic
{
    public string Command { get; set; } = string.Empty;
    public int ElapsedMs { get; set; }
    public List<string> Stderr { get; set; } = [];
}
