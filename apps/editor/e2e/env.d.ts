/**
 * E2E derlemesi için minimal Node ortam bildirimi.
 *
 * BİLİNÇLİ olarak `@types/node` devDependency'si EKLENMEZ: uygulamanın
 * tsconfig'inde `types` listesi yok, dolayısıyla node_modules/@types altındaki
 * her paket `tsc -b` sırasında src'ye de global olarak enjekte olurdu
 * (setTimeout -> NodeJS.Timeout gibi klasik DOM/Node çakışmaları yeşil
 * typecheck'i bozar). E2E'nin ihtiyacı yalnızca `process.env`.
 */
export {};

declare global {
  // eslint-disable-next-line no-var
  var process: {
    env: Record<string, string | undefined>;
    exit(code?: number): never;
  };
}
