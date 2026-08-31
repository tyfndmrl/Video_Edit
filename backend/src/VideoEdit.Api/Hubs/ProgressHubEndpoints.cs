using Microsoft.AspNetCore.Routing;
using VideoEdit.Contracts;

namespace VideoEdit.Api.Hubs;

/// <summary>
/// Hub kaydı, diğer uç grupları gibi bir <c>Map*Endpoints</c> sınıfında yaşar — BİLEREK:
/// <c>CrossUserEndpointInventoryTests</c> muhafızı rota tablosunu bu imzadaki metotları
/// koşturarak kurar ve Program.cs'te satır-içi rota tanımını yasaklar. Hub'ı Program.cs'te
/// <c>MapHub</c> ile kaydetmek muhafızın GÖRMEDİĞİ bir uç yaratırdı; burada kaydetmek hub'ın
/// negotiate + bağlantı uçlarını envanter defterinin kapsamına sokar (defter satırları
/// hub'ın abonelik-kapısı testlerine işaret eder).
/// </summary>
public static class ProgressHubEndpoints
{
    public static IEndpointRouteBuilder MapProgressHubEndpoints(this IEndpointRouteBuilder app)
    {
        // RequireAuthorization: [Authorize] sınıf attribute'unun uç metadata'sındaki eşi —
        // anonim istemci negotiate'te 401 alır; muhafız da ucu [auth] olarak sınıflar.
        app.MapHub<JobProgressHub>(JobProgressChannel.HubPath).RequireAuthorization();
        return app;
    }
}
