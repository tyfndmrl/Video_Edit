/**
 * auth hata düzleştirme — ProblemDetails/ValidationProblem gövdelerinden
 * kullanıcı mesajı üretimi (register: errors sözlüğü; login: jenerik 401).
 */
import { describe, expect, it } from 'vitest';
import { loginErrorMessage, registerErrorMessage } from './auth';
import { flattenProblemErrors, problemDetailsMessage } from './problemDetails';

describe('flattenProblemErrors', () => {
  it('flattens a field -> messages dictionary in order', () => {
    expect(
      flattenProblemErrors({
        email: ['Email is required.'],
        displayName: ['Display name is required (max 100 characters).'],
      }),
    ).toEqual(['Email is required.', 'Display name is required (max 100 characters).']);
  });

  it('accepts plain string values and skips blanks/non-strings', () => {
    expect(flattenProblemErrors({ a: 'Tek mesaj', b: ['  '], c: [42], d: [] })).toEqual(['Tek mesaj']);
  });

  it('returns [] for missing/invalid input', () => {
    expect(flattenProblemErrors(undefined)).toEqual([]);
    expect(flattenProblemErrors(null)).toEqual([]);
    expect(flattenProblemErrors('nope')).toEqual([]);
  });
});

describe('problemDetailsMessage', () => {
  it('prefers the errors dictionary when the title is the generic ValidationProblem one', () => {
    expect(
      problemDetailsMessage({
        title: 'One or more validation errors occurred.',
        errors: {
          PasswordTooShort: ['Passwords must be at least 8 characters.'],
          PasswordRequiresDigit: ["Passwords must have at least one digit ('0'-'9')."],
        },
      }),
    ).toBe(
      "Passwords must be at least 8 characters. Passwords must have at least one digit ('0'-'9').",
    );
  });

  it('uses a meaningful title (with detail when present)', () => {
    expect(problemDetailsMessage({ title: 'Invalid email or password.' })).toBe(
      'Invalid email or password.',
    );
    expect(problemDetailsMessage({ title: 'Quota exceeded', detail: 'Storage limit reached.' })).toBe(
      'Quota exceeded — Storage limit reached.',
    );
  });

  it('falls back to errors when only errors exist, null when nothing usable', () => {
    expect(problemDetailsMessage({ errors: { x: ['Boom.'] }, title: 'Custom title' })).toBe(
      'Custom title',
    );
    expect(problemDetailsMessage({ errors: { x: ['Boom.'] } })).toBe('Boom.');
    expect(problemDetailsMessage({})).toBeNull();
    expect(problemDetailsMessage(null)).toBeNull();
    expect(problemDetailsMessage('plain text')).toBeNull();
  });
});

describe('registerErrorMessage', () => {
  it('surfaces the Identity password rule descriptions instead of the generic title', () => {
    const body = {
      title: 'One or more validation errors occurred.',
      status: 400,
      errors: {
        PasswordTooShort: ['Passwords must be at least 8 characters.'],
        PasswordRequiresLower: ["Passwords must have at least one lowercase ('a'-'z')."],
      },
    };
    expect(registerErrorMessage(400, body)).toBe(
      "Passwords must be at least 8 characters. Passwords must have at least one lowercase ('a'-'z').",
    );
  });

  it('keeps a non-generic title', () => {
    expect(registerErrorMessage(400, { title: 'DuplicateEmail' })).toBe('DuplicateEmail');
  });

  it('falls back to a Turkish generic with the HTTP status', () => {
    expect(registerErrorMessage(429, null)).toBe('Kayıt başarısız (HTTP 429).');
    expect(registerErrorMessage(500, {})).toBe('Kayıt başarısız (HTTP 500).');
  });
});

describe('loginErrorMessage', () => {
  it('maps 401 to the fixed Turkish credentials message', () => {
    // Backend 401 gövdesi bilinçli jeneriktir (enumeration koruması) — mesajı biz yazarız.
    expect(loginErrorMessage(401, { title: 'Invalid email or password.' })).toBe(
      'E-posta veya şifre hatalı.',
    );
    expect(loginErrorMessage(401, null)).toBe('E-posta veya şifre hatalı.');
  });

  it('uses the ProblemDetails title for other statuses', () => {
    expect(loginErrorMessage(423, { title: 'Service unavailable' })).toBe('Service unavailable');
  });

  it('falls back to a Turkish generic with the HTTP status', () => {
    expect(loginErrorMessage(500, null)).toBe('Giriş başarısız (HTTP 500).');
  });
});
