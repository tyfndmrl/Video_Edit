using System.Security.Claims;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using VideoEdit.Api.Hubs;

namespace VideoEdit.UnitTests;

/// <summary>
/// Hub testlerinin ortak sahteleri (CrossUserAccessTests'in Hub_* kapı testleri +
/// ProgressHubTests paylaşır). Desen depodaki diğer sahtelerle aynıdır: mock kütüphanesi
/// yok, kaydeden el yazması sınıflar — hub HİÇ başlatılmadan, gerçek Sqlite DbContext'le
/// in-process çağrılır (SignalR taşıma katmanı bu testlerin iddiası değildir; o katman
/// gerçek WebSocket'le e2e'de kanıtlanır).
/// </summary>
public sealed class TestHubCallerContext(ClaimsPrincipal user, string connectionId = "test-conn-1")
    : HubCallerContext
{
    public override string ConnectionId => connectionId;

    public override string? UserIdentifier => null;

    public override ClaimsPrincipal? User => user;

    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();

    public override IFeatureCollection Features { get; } = new FeatureCollection();

    public override CancellationToken ConnectionAborted => CancellationToken.None;

    public override void Abort()
    {
    }
}

/// <summary>Grup üyeliği çağrılarını kaydeden IGroupManager (hub'ın Groups yüzeyi).</summary>
public sealed class RecordingGroupManager : IGroupManager
{
    public List<(string ConnectionId, string Group)> Added { get; } = [];

    public List<(string ConnectionId, string Group)> Removed { get; } = [];

    public Task AddToGroupAsync(
        string connectionId, string groupName, CancellationToken cancellationToken = default)
    {
        Added.Add((connectionId, groupName));
        return Task.CompletedTask;
    }

    public Task RemoveFromGroupAsync(
        string connectionId, string groupName, CancellationToken cancellationToken = default)
    {
        Removed.Add((connectionId, groupName));
        return Task.CompletedTask;
    }
}

/// <summary>
/// Forwarder testinin IHubContext sahtesi: hangi GRUBA hangi metotla hangi argümanların
/// gönderildiğini kaydeder — forwarder'ın "Redis mesajı doğru gruba gitti" iddiasının
/// ölçüm yüzeyi.
/// </summary>
public sealed class RecordingHubContext : IHubContext<JobProgressHub>
{
    public List<(string Group, string Method, object?[] Args)> Sent { get; } = [];

    public IHubClients Clients => new GroupOnlyClients(this);

    public IGroupManager Groups { get; } = new RecordingGroupManager();

    private sealed class GroupOnlyClients(RecordingHubContext owner) : IHubClients
    {
        public IClientProxy All => throw NotGroup();

        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => throw NotGroup();

        public IClientProxy Client(string connectionId) => throw NotGroup();

        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => throw NotGroup();

        public IClientProxy Group(string groupName) => new Proxy(owner, groupName);

        public IClientProxy Groups(IReadOnlyList<string> groupNames) => throw NotGroup();

        public IClientProxy GroupExcept(
            string groupName, IReadOnlyList<string> excludedConnectionIds) => throw NotGroup();

        public IClientProxy User(string userId) => throw NotGroup();

        public IClientProxy Users(IReadOnlyList<string> userIds) => throw NotGroup();

        private static InvalidOperationException NotGroup() =>
            new("Forwarder yalnız Group(...) hedeflemeli — başka hedef kullanımı sözleşme dışıdır.");
    }

    private sealed class Proxy(RecordingHubContext owner, string group) : IClientProxy
    {
        public Task SendCoreAsync(
            string method, object?[] args, CancellationToken cancellationToken = default)
        {
            owner.Sent.Add((group, method, args));
            return Task.CompletedTask;
        }
    }
}
