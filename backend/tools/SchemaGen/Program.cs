// SchemaGen — packages/timeline-schema/generated/timeline.schema.json (draft-7) dosyasından
// VideoEdit.Contracts için System.Text.Json uyumlu C# DTO'ları üretir (NJsonSchema).
//
// Kullanım:
//   dotnet run --project backend/tools/SchemaGen                  (repo kökünü kendisi bulur)
//   dotnet run --project backend/tools/SchemaGen -- <input> <output>
//
// NJsonSchema, zod'un draft-7 çıktısındaki bazı kalıpları C#'a düzgün çeviremiyor
// (discriminatedUnion -> oneOf, nullable -> anyOf[ref,null], tek-ref allOf sarmalayıcıları).
// Bu araç üretimden önce şemayı NJsonSchema'nın anladığı eşdeğer kalıplara dönüştürür ve
// union'lar için System.Text.Json discriminator converter'larını dosyanın sonuna ekler.

using System.Text;
using NJsonSchema;
using NJsonSchema.CodeGeneration.CSharp;

const string DefaultInputRelative = "packages/timeline-schema/generated/timeline.schema.json";
const string DefaultOutputRelative = "backend/src/VideoEdit.Contracts/Generated/TimelineContracts.g.cs";

string inputPath;
string outputPath;

if (args.Length >= 2)
{
    inputPath = Path.GetFullPath(args[0]);
    outputPath = Path.GetFullPath(args[1]);
}
else if (args.Length == 1)
{
    Console.Error.WriteLine("Usage: SchemaGen [<input timeline.schema.json> <output TimelineContracts.g.cs>]");
    return 2;
}
else
{
    var repoRoot = FindRepoRoot(Directory.GetCurrentDirectory()) ?? FindRepoRoot(AppContext.BaseDirectory);
    if (repoRoot is null)
    {
        Console.Error.WriteLine(
            "SchemaGen: repo root not found (looked upwards for pnpm-workspace.yaml / VideoEdit.sln). " +
            "Run from inside the repo or pass explicit <input> <output> paths.");
        return 1;
    }

    inputPath = Path.Combine(repoRoot, DefaultInputRelative.Replace('/', Path.DirectorySeparatorChar));
    outputPath = Path.Combine(repoRoot, DefaultOutputRelative.Replace('/', Path.DirectorySeparatorChar));
}

if (!File.Exists(inputPath))
{
    Console.Error.WriteLine($"SchemaGen: input schema not found: {inputPath}");
    Console.Error.WriteLine("Run `pnpm --filter @videoedit/timeline-schema generate` first.");
    return 1;
}

var schemaJson = await File.ReadAllTextAsync(inputPath);
var schema = await JsonSchema.FromJsonAsync(schemaJson);

// --- Schema post-processing (order matters) ---------------------------------------------------

// 1) All *Us fields are integer microseconds and must be `long` in C#. zod emits
//    `"type": "integer", "maximum": 9007199254740991` (JS safe-int bound) without an int64
//    format hint, which NJsonSchema would map to `int`.
PromoteWideIntegersToInt64(schema);

// 2) Definitions that are exactly `allOf: [$ref X]` (zod emits these for `.optional()`
//    wrappers of named schemas) confuse NJsonSchema: the wrapper steals X's type identity and
//    X's class silently disappears. Re-point every reference straight at X and drop them.
CollapseTrivialAllOfWrappers(schema);

// 3) `anyOf: [$ref X, {type: null}]` (zod `.nullable()`) generates a bogus property-bag class.
//    Rewrite referencing sites to the standard nullable-reference pattern.
CollapseNullableUnions(schema);

// 4) anyOf unions of PRIMITIVES (e.g. audioSampleRate 44100|48000, effect param number|string)
//    also generate bogus property-bag classes. Collapse to a single primitive or `object`.
CollapsePrimitiveUnions(schema);

// 5) Array definitions (`__schemaN: {type: array, items: $ref T}`) would each become a
//    separate `class __schemaN : List<T>` wrapper. Inline them at the referencing property so
//    properties are plain `List<T>`.
InlineArrayDefinitions(schema);

// 6) zod's toJSONSchema names anonymous sub-schemas `__schemaN`. Give the ones that become
//    C# types readable names derived from schema structure (discriminator const for union
//    members, container+property for single-use definitions).
RenameAnonymousDefinitions(schema);

// 7) discriminatedUnion -> oneOf: NJsonSchema cannot generate a usable type for a bare oneOf
//    (the first member's class is silently consumed as the union's "type schema"). Convert to
//    base-class + allOf inheritance and remember the discriminator mapping so we can append
//    System.Text.Json converters below.
var unions = ConvertDiscriminatedUnionsToInheritance(schema);

var settings = new CSharpGeneratorSettings
{
    Namespace = "VideoEdit.Contracts.Timeline",
    JsonLibrary = CSharpJsonLibrary.SystemTextJson,
    ClassStyle = CSharpClassStyle.Poco,
    GenerateNullableReferenceTypes = true,
    GenerateOptionalPropertiesAsNullable = true,
    GenerateDataAnnotations = false,
    GenerateJsonMethods = false,
    GenerateDefaultValues = false,
    ArrayType = "System.Collections.Generic.List",
    ArrayInstanceType = "System.Collections.Generic.List",
    ArrayBaseType = "System.Collections.Generic.List",
    DictionaryType = "System.Collections.Generic.Dictionary",
    DictionaryInstanceType = "System.Collections.Generic.Dictionary",
    DictionaryBaseType = "System.Collections.Generic.Dictionary",
};

var generator = new CSharpGenerator(schema, settings);
var code = generator.GenerateFile("TimelineDoc");

// NJsonSchema enum üyelerini yalnız [EnumMember] ile işaretler; System.Text.Json bunu yok
// sayar ve PascalCase üye adını yazar ("audio" yerine "Audio"). .NET 9+ attribute'u ile tel
// formatını şemadaki değere sabitle.
code = System.Text.RegularExpressions.Regex.Replace(
    code,
    """(?m)^(\s*)\[System\.Runtime\.Serialization\.EnumMember\(Value = @"([^"]*)"\)\]\r?$""",
    "$1[System.Runtime.Serialization.EnumMember(Value = @\"$2\")]\n$1[System.Text.Json.Serialization.JsonStringEnumMemberName(\"$2\")]");

var header =
    "// <auto-generated/>\n" +
    "// Source: packages/timeline-schema/generated/timeline.schema.json (draft-7, generated from the zod schema).\n" +
    "// Regenerate with: pnpm schema:generate\n" +
    "//   (or only this file: dotnet run --project backend/tools/SchemaGen)\n" +
    "// Do NOT edit by hand — changes will be overwritten.\n\n";

var output = header + code.Replace("\r\n", "\n") + GenerateUnionConverters(settings.Namespace, unions);

Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
await File.WriteAllTextAsync(outputPath, output);
Console.WriteLine($"SchemaGen: wrote {outputPath}");
return 0;

// --- Helpers ----------------------------------------------------------------------------------

static string? FindRepoRoot(string start)
{
    for (var dir = new DirectoryInfo(Path.GetFullPath(start)); dir is not null; dir = dir.Parent)
    {
        // Repo root carries pnpm-workspace.yaml; the solution lives one level below in backend/.
        if (File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml")))
        {
            return dir.FullName;
        }

        if (File.Exists(Path.Combine(dir.FullName, "VideoEdit.sln")))
        {
            return dir.Parent?.FullName;
        }
    }

    return null;
}

static void PromoteWideIntegersToInt64(JsonSchema root)
{
    foreach (var s in EnumerateSchemas(root))
    {
        if (s.Type.HasFlag(JsonObjectType.Integer)
            && string.IsNullOrEmpty(s.Format)
            && (s.Maximum is null || s.Maximum > int.MaxValue || s.Minimum < int.MinValue))
        {
            s.Format = JsonFormatStrings.Long;
        }
    }
}

static void CollapseTrivialAllOfWrappers(JsonSchema root)
{
    foreach (var (key, def) in root.Definitions.ToList())
    {
        if (def.AllOf.Count != 1 || !def.AllOf.First().HasReference
            || def.Properties.Count > 0 || def.OneOf.Count > 0 || def.AnyOf.Count > 0
            || def.Type != JsonObjectType.None)
        {
            continue;
        }

        var target = def.AllOf.First().Reference!;
        foreach (var s in EnumerateSchemas(root))
        {
            if (ReferenceEquals(s.Reference, def))
            {
                s.Reference = target;
            }
        }

        root.Definitions.Remove(key);
    }
}

static void CollapseNullableUnions(JsonSchema root)
{
    foreach (var (key, def) in root.Definitions.ToList())
    {
        var union = def.AnyOf.Count == 2 ? def.AnyOf : def.OneOf.Count == 2 ? def.OneOf : null;
        if (union is null || def.Properties.Count > 0 || def.Type != JsonObjectType.None)
        {
            continue;
        }

        var reference = union.FirstOrDefault(s => s.HasReference)?.Reference;
        var hasNull = union.Any(s => s.Type == JsonObjectType.Null);
        if (reference is null || !hasNull)
        {
            continue;
        }

        foreach (var s in EnumerateSchemas(root).ToList())
        {
            if (ReferenceEquals(s.Reference, def))
            {
                // Standard nullable-reference pattern NJsonSchema understands.
                s.Reference = null;
                s.OneOf.Add(new JsonSchema { Reference = reference });
                s.OneOf.Add(new JsonSchema { Type = JsonObjectType.Null });
            }
        }

        root.Definitions.Remove(key);
    }
}

static void CollapsePrimitiveUnions(JsonSchema root)
{
    foreach (var s in EnumerateSchemas(root).ToList())
    {
        var union = s.AnyOf.Count > 1 ? s.AnyOf : null;
        if (union is null || s.Properties.Count > 0 || s.Type != JsonObjectType.None
            || union.Any(m => m.HasReference))
        {
            continue;
        }

        var types = union.Select(m => m.Type).Where(t => t != JsonObjectType.Null).Distinct().ToList();
        var primitive = types.All(t =>
            t is JsonObjectType.String or JsonObjectType.Number or JsonObjectType.Integer or JsonObjectType.Boolean);
        if (!primitive || types.Count == 0)
        {
            continue;
        }

        var nullable = union.Any(m => m.Type == JsonObjectType.Null);
        if (types.Count == 1)
        {
            var type = types[0];
            // All-integral numeric consts (e.g. 44100|48000) are better represented as integer.
            if (type == JsonObjectType.Number && union.All(m =>
                    m.Type == JsonObjectType.Null || (ConstOf(m) is decimal d && decimal.Truncate(d) == d)))
            {
                type = JsonObjectType.Integer;
            }

            s.Type = nullable ? type | JsonObjectType.Null : type;
        }
        // else: heterogeneous primitives (number|string) -> leave untyped => C# object.

        s.AnyOf.Clear();
    }
}

static void InlineArrayDefinitions(JsonSchema root)
{
    foreach (var (key, def) in root.Definitions.ToList())
    {
        if (!IsAnonymous(key) || def.Type != JsonObjectType.Array || def.Item is null
            || def.Properties.Count > 0 || def.OneOf.Count > 0 || def.AnyOf.Count > 0 || def.AllOf.Count > 0)
        {
            continue;
        }

        var item = def.Item.HasReference ? def.Item.Reference! : def.Item;
        foreach (var s in EnumerateSchemas(root).ToList())
        {
            if (ReferenceEquals(s.Reference, def))
            {
                s.Reference = null;
                s.Type = JsonObjectType.Array;
                s.Item = new JsonSchema { Reference = item };
                s.MaxItems = def.MaxItems;
                s.MinItems = def.MinItems;
            }
        }

        root.Definitions.Remove(key);
    }
}

static void RenameAnonymousDefinitions(JsonSchema root)
{
    if (root.Definitions.Count == 0)
    {
        return;
    }

    // Reverse lookup: anonymous definition -> desired name.
    var renames = new Dictionary<JsonSchema, string>();

    // (a) Union members referenced from a NAMED definition's oneOf, carrying a const/enum
    //     discriminator property (zod discriminatedUnion output): Easing -> EasingLinear, ...
    foreach (var (defName, def) in root.Definitions.Where(d => !IsAnonymous(d.Key)))
    {
        foreach (var member in def.OneOf)
        {
            var target = member.HasReference ? member.Reference! : member;
            var key = KeyOf(root, target);
            if (key is null || !IsAnonymous(key))
            {
                continue;
            }

            var values = DiscriminatorValues(target, DiscriminatorPropertyOf(def));
            if (values.Count == 1)
            {
                renames.TryAdd(target, defName + Pascal(values[0]));
            }
        }
    }

    // (b) Definitions referenced by exactly one object property: <Container><Property>.
    //     Only schemas that actually become C# types (objects or string enums) are renamed.
    var propertyRefs = new Dictionary<JsonSchema, List<(string Container, string Property)>>();
    foreach (var (defName, def) in root.Definitions)
    {
        foreach (var (propName, prop) in def.ActualSchema.Properties)
        {
            var target = prop.HasReference
                ? prop.Reference!
                : prop.OneOf.FirstOrDefault(o => o.HasReference)?.Reference;
            if (target is null)
            {
                continue;
            }

            if (!propertyRefs.TryGetValue(target, out var list))
            {
                propertyRefs[target] = list = [];
            }

            list.Add((IsAnonymous(defName) ? "" : defName, propName));
        }
    }

    foreach (var (target, referrers) in propertyRefs)
    {
        var key = KeyOf(root, target);
        if (key is null || !IsAnonymous(key) || renames.ContainsKey(target) || referrers.Count != 1)
        {
            continue;
        }

        var producesType = target.Type.HasFlag(JsonObjectType.Object)
            || (target.IsEnumeration && target.Type.HasFlag(JsonObjectType.String));
        if (!producesType)
        {
            continue;
        }

        var (container, property) = referrers[0];
        renames.TryAdd(target, Pascal(container) + Pascal(property));
    }

    foreach (var (target, newName) in renames)
    {
        var key = KeyOf(root, target);
        if (key is null || root.Definitions.ContainsKey(newName))
        {
            continue; // never overwrite an existing (named) definition
        }

        root.Definitions.Remove(key);
        root.Definitions[newName] = target;
    }
}

static List<UnionInfo> ConvertDiscriminatedUnionsToInheritance(JsonSchema root)
{
    var unions = new List<UnionInfo>();
    foreach (var (unionName, def) in root.Definitions.ToList())
    {
        if (def.OneOf.Count < 2 || def.Type != JsonObjectType.None || def.Properties.Count > 0
            || !def.OneOf.All(m => m.HasReference))
        {
            continue;
        }

        var members = def.OneOf.Select(m => m.Reference!).ToList();
        var discriminator = DiscriminatorPropertyOf(def);
        if (discriminator is null)
        {
            continue;
        }

        var mapping = new List<(string Value, string TypeName)>();
        foreach (var member in members)
        {
            var memberName = KeyOf(root, member);
            if (memberName is null)
            {
                continue;
            }

            foreach (var value in DiscriminatorValues(member, discriminator))
            {
                mapping.Add((value, memberName));
            }
        }

        if (mapping.Count == 0)
        {
            continue;
        }

        // Base type: empty abstract object (members keep their own discriminator property).
        def.OneOf.Clear();
        def.Type = JsonObjectType.Object;
        def.IsAbstract = true;
        def.AllowAdditionalProperties = false;

        // Members become `allOf: [base, body]` so NJsonSchema emits `class Member : Base`.
        foreach (var member in members)
        {
            var memberName = KeyOf(root, member);
            if (memberName is null)
            {
                continue;
            }

            var wrapper = new JsonSchema();
            wrapper.AllOf.Add(new JsonSchema { Reference = def });
            wrapper.AllOf.Add(member);
            root.Definitions[memberName] = wrapper;
        }

        unions.Add(new UnionInfo(unionName, discriminator, mapping));
    }

    return unions;
}

/// <summary>Property name that carries a const/enum string discriminator in every oneOf member.</summary>
static string? DiscriminatorPropertyOf(JsonSchema unionDef)
{
    var members = unionDef.OneOf
        .Select(m => m.HasReference ? m.Reference! : m)
        .Select(m => m.ActualSchema)
        .ToList();
    if (members.Count == 0)
    {
        return null;
    }

    foreach (var candidate in members[0].Properties.Keys)
    {
        if (members.All(m => DiscriminatorValues(m, candidate).Count > 0))
        {
            return candidate;
        }
    }

    return null;
}

/// <summary>All const/enum string values of a member's discriminator property.</summary>
static IReadOnlyList<string> DiscriminatorValues(JsonSchema member, string? propertyName)
{
    if (propertyName is null
        || !member.ActualSchema.Properties.TryGetValue(propertyName, out var property))
    {
        return [];
    }

    var actual = property.ActualSchema;
    if (actual.Enumeration.Count > 0)
    {
        return actual.Enumeration.OfType<string>().ToList();
    }

    if (actual.ExtensionData is not null
        && actual.ExtensionData.TryGetValue("const", out var constValue)
        && constValue is string s)
    {
        return [s];
    }

    return [];
}

static object? ConstOf(JsonSchema s)
{
    if (s.Enumeration.Count == 1)
    {
        var value = s.Enumeration.First();
        return value is int i ? (decimal)i : value is long l ? (decimal)l : value is double d ? (decimal)d : value;
    }

    if (s.ExtensionData is not null && s.ExtensionData.TryGetValue("const", out var c))
    {
        return c is int i ? (decimal)i : c is long l ? (decimal)l : c is double d ? (decimal)d : c;
    }

    return null;
}

static string GenerateUnionConverters(string ns, List<UnionInfo> unions)
{
    if (unions.Count == 0)
    {
        return string.Empty;
    }

    var sb = new StringBuilder();
    sb.Append('\n');
    sb.Append("// --- Discriminated union support (SchemaGen) --------------------------------------------\n");
    sb.Append("// zod discriminatedUnion -> abstract base + discriminator dispatch. The concrete classes\n");
    sb.Append("// keep their own discriminator property as the single source of truth, so serialization\n");
    sb.Append("// is plain member serialization and round-trips byte-for-byte.\n\n");
    sb.Append($"namespace {ns}\n{{\n");

    foreach (var union in unions)
    {
        sb.Append($"    [System.Text.Json.Serialization.JsonConverter(typeof({union.Name}JsonConverter))]\n");
        sb.Append($"    public abstract partial class {union.Name}\n    {{\n    }}\n\n");

        sb.Append($"    /// <summary>Dispatches <c>\"{union.DiscriminatorProperty}\"</c> to the concrete {union.Name} type.</summary>\n");
        sb.Append("    [System.CodeDom.Compiler.GeneratedCode(\"SchemaGen\", \"1.0\")]\n");
        sb.Append($"    internal sealed class {union.Name}JsonConverter : System.Text.Json.Serialization.JsonConverter<{union.Name}>\n");
        sb.Append("    {\n");
        sb.Append($"        public override {union.Name}? Read(ref System.Text.Json.Utf8JsonReader reader, System.Type typeToConvert, System.Text.Json.JsonSerializerOptions options)\n");
        sb.Append("        {\n");
        sb.Append("            using var document = System.Text.Json.JsonDocument.ParseValue(ref reader);\n");
        sb.Append($"            if (!document.RootElement.TryGetProperty(\"{union.DiscriminatorProperty}\", out var discriminator))\n");
        sb.Append("            {\n");
        sb.Append($"                throw new System.Text.Json.JsonException(\"Missing discriminator property '{union.DiscriminatorProperty}' for {union.Name}.\");\n");
        sb.Append("            }\n\n");
        sb.Append("            var json = document.RootElement.GetRawText();\n");
        sb.Append("            return discriminator.GetString() switch\n");
        sb.Append("            {\n");
        foreach (var (value, typeName) in union.Mapping)
        {
            sb.Append($"                \"{value}\" => System.Text.Json.JsonSerializer.Deserialize<{typeName}>(json, options),\n");
        }

        sb.Append($"                var unknown => throw new System.Text.Json.JsonException($\"Unknown {union.Name} discriminator '{{unknown}}'.\"),\n");
        sb.Append("            };\n");
        sb.Append("        }\n\n");
        sb.Append($"        public override void Write(System.Text.Json.Utf8JsonWriter writer, {union.Name} value, System.Text.Json.JsonSerializerOptions options)\n");
        sb.Append("        {\n");
        sb.Append("            System.Text.Json.JsonSerializer.Serialize(writer, value, value.GetType(), options);\n");
        sb.Append("        }\n");
        sb.Append("    }\n\n");
    }

    sb.Append("}\n");
    return sb.ToString();
}

static bool IsAnonymous(string definitionKey) =>
    definitionKey.StartsWith("__schema", StringComparison.Ordinal);

static string? KeyOf(JsonSchema root, JsonSchema definition) =>
    root.Definitions.FirstOrDefault(kv => ReferenceEquals(kv.Value, definition)).Key;

static string Pascal(string value)
{
    if (value.Length == 0)
    {
        return value;
    }

    return char.ToUpperInvariant(value[0]) + value[1..];
}

static IEnumerable<JsonSchema> EnumerateSchemas(JsonSchema root)
{
    var seen = new HashSet<JsonSchema>();
    var stack = new Stack<JsonSchema>();
    stack.Push(root);
    while (stack.Count > 0)
    {
        var current = stack.Pop();
        if (!seen.Add(current))
        {
            continue;
        }

        yield return current;

        foreach (var child in Children(current))
        {
            if (child is not null)
            {
                stack.Push(child);
            }
        }
    }

    static IEnumerable<JsonSchema?> Children(JsonSchema s)
    {
        foreach (var d in s.Definitions.Values) yield return d;
        foreach (var p in s.Properties.Values) yield return p;
        foreach (var p in s.PatternProperties.Values) yield return p;
        foreach (var o in s.OneOf) yield return o;
        foreach (var a in s.AnyOf) yield return a;
        foreach (var a in s.AllOf) yield return a;
        yield return s.Item;
        foreach (var i in s.Items) yield return i;
        yield return s.AdditionalPropertiesSchema;
        yield return s.AdditionalItemsSchema;
        yield return s.Not;
        if (s.HasReference) yield return s.Reference;
    }
}

internal sealed record UnionInfo(
    string Name,
    string DiscriminatorProperty,
    List<(string Value, string TypeName)> Mapping);
