/**
 * problemDetails — ASP.NET ProblemDetails / ValidationProblem gövdelerini
 * kullanıcıya gösterilebilir tek bir mesaja indirger.
 *
 * Bağımsız modül (apiClient'a import edilmez) — auth.ts ve upload hata
 * eşlemesi buradan beslenir; apiClient <-> auth döngüsüne girmez.
 */

/**
 * ASP.NET `Results.ValidationProblem` başlığı — tek başına bilgi taşımaz;
 * bu başlık görüldüğünde errors sözlüğü mesaj olarak tercih edilir.
 */
const GENERIC_PROBLEM_TITLES = new Set(['One or more validation errors occurred.']);

/**
 * ValidationProblem `errors` sözlüğünü ({ alan: [mesaj, ...] }) düz bir mesaj
 * listesine çevirir. Identity hataları da bu şekildedir (kod -> açıklamalar).
 */
export function flattenProblemErrors(errors: unknown): string[] {
  if (typeof errors !== 'object' || errors === null) return [];
  const out: string[] = [];
  for (const value of Object.values(errors as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const message of value) {
        if (typeof message === 'string' && message.trim() !== '') out.push(message.trim());
      }
    } else if (typeof value === 'string' && value.trim() !== '') {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * Bir hata gövdesinden anlamlı mesaj çıkarır:
 * 1. errors sözlüğü dolu ve title yok/jenerikse -> errors birleşimi,
 * 2. title (+ varsa detail),
 * 3. yalnız errors varsa errors birleşimi,
 * 4. hiçbiri yoksa null (çağıran kendi fallback'ini kullanır).
 */
export function problemDetailsMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const pd = body as { title?: unknown; detail?: unknown; errors?: unknown };
  const title = typeof pd.title === 'string' ? pd.title.trim() : '';
  const detail = typeof pd.detail === 'string' ? pd.detail.trim() : '';
  const errors = flattenProblemErrors(pd.errors);
  const titleGeneric = title === '' || GENERIC_PROBLEM_TITLES.has(title);

  if (errors.length > 0 && titleGeneric) return errors.join(' ');
  const parts: string[] = [];
  if (title) parts.push(title);
  if (detail) parts.push(detail);
  if (parts.length > 0) return parts.join(' — ');
  if (errors.length > 0) return errors.join(' ');
  return null;
}
