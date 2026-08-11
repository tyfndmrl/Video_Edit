# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: probe.spec.ts >> beklenen basarisizlik (test.fail) — guard TAKILMAMALI
- Location: e2e\.artifacts\guardcheck\probe.spec.ts:2:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 1
```

# Test source

```ts
  1 | import { test, expect } from '@playwright/test';
  2 | test('beklenen basarisizlik (test.fail) — guard TAKILMAMALI', async () => {
  3 |   test.fail(true, 'urun henuz uygulamiyor');
> 4 |   expect(1).toBe(2);
    |             ^ Error: expect(received).toBe(expected) // Object.is equality
  5 | });
  6 | test('kosan test', async () => {
  7 |   expect(1).toBe(1);
  8 | });
  9 | 
```