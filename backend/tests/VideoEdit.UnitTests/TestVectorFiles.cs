namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language test vektörü dosyalarına erişim. Vektörler pnpm workspace'inde yaşar
/// (packages/timeline-schema/test-vectors); test bin dizininden yukarı çıkarak repo kökünü
/// bulur (pnpm-workspace.yaml köktedir; VideoEdit.sln backend/ altındadır).
/// </summary>
internal static class TestVectorFiles
{
    public static string RepoRoot { get; } = FindRepoRoot();

    public static string Resolve(string repoRelativePath) =>
        Path.Combine(RepoRoot, repoRelativePath.Replace('/', Path.DirectorySeparatorChar));

    private static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml")))
            {
                return dir.FullName;
            }

            if (File.Exists(Path.Combine(dir.FullName, "VideoEdit.sln")) && dir.Parent is not null)
            {
                return dir.Parent.FullName;
            }
        }

        throw new InvalidOperationException(
            $"Repo root not found walking up from '{AppContext.BaseDirectory}' " +
            "(expected pnpm-workspace.yaml or VideoEdit.sln on the way up).");
    }
}
