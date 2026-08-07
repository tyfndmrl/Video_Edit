namespace VideoEdit.Media.Recipes;

/// <summary>
/// VFR → CFR normalizasyonu (rendering-semantics §1.6 — NORMATİF):
/// VFR kaynağın nominal CFR'ı, avg_frame_rate'e EN YAKIN standart oran
/// {23.976, 24, 25, 29.97, 30, 50, 59.94, 60} kümesinden seçilir.
/// Rational olarak döner — float fps hiçbir katmana sızmaz.
/// </summary>
public static class NominalCfr
{
    private static readonly (int Num, int Den)[] StandardRates =
    [
        (24000, 1001), // 23.976
        (24, 1),
        (25, 1),
        (30000, 1001), // 29.97
        (30, 1),
        (50, 1),
        (60000, 1001), // 59.94
        (60, 1),
    ];

    public static (int Num, int Den) FromAvg(int avgNum, int avgDen)
    {
        if (avgNum <= 0 || avgDen <= 0)
        {
            return (30, 1); // savunma — parser geçersiz avg'ı r'a düşürür, buraya normalde gelinmez
        }

        var avg = (double)avgNum / avgDen;
        var best = StandardRates[0];
        var bestDistance = double.MaxValue;
        foreach (var rate in StandardRates)
        {
            var distance = Math.Abs(avg - ((double)rate.Num / rate.Den));
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = rate;
            }
        }

        return best;
    }
}
