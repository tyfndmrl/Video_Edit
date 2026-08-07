namespace VideoEdit.Domain;

/// <summary>
/// Domain kuralı ihlali (geçersiz durum geçişi vb.). API katmanında 400'e map'lenir.
/// </summary>
public class DomainException : Exception
{
    public DomainException(string message) : base(message)
    {
    }
}
