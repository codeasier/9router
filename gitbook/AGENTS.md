# Static documentation site

Inherits [repository guidance](../AGENTS.md). `9router-docs` is an independent Next.js package exporting static documentation. It has its own dependencies, configuration and `@/*` alias; the gateway build excludes this subtree from output tracing.

## Content and routes

| Path | Responsibility |
|---|---|
| `content/<lang>/` | Markdown documentation, with `index.md` as the language landing page |
| `constants/languages.js` | Supported language codes and the default language (`en`) |
| `constants/docsConfig.js` | Shared navigation slugs and per-language labels |
| `lib/content.js` | Filesystem content lookup, English fallback and slug discovery |
| `app/[lang]/page.js` | Language index pages |
| `app/[lang]/[...slug]/page.js` | Generated documentation pages |
| `components/`, `utils/markdown.js` | Documentation layout, navigation and Markdown rendering/headings |

Nested pages are generated from **default-language slugs × configured languages**. `dynamicParams=false` means adding only a translated Markdown file does not create a new exported route. Add its English counterpart and navigation entry as appropriate. Missing translations fall back to English at content load time.

## Development, export and deployment

Commands run from `gitbook/`, because `lib/content.js` resolves `content/` from `process.cwd()`. Install this package's dependencies separately; installation may access the registry and execute hooks.

| Command | Target |
|---|---|
| `npm run dev` | Documentation development server on `3001` |
| `npm run build` | Next static export into `out/`, with `.next/` build intermediates |
| `npm run start` | Declared `next start -p 3001` script; not the serving path for this `output: "export"` configuration |
| `npm run deploy` | Builds, then invokes Wrangler to deploy `out/` to Cloudflare Pages project `9router-docs`; requires network access and deployment credentials |

The configured production consumer is a static host, not a gateway standalone server. [GitHub Pages CI](../.github/workflows/gitbook-pages.yml) separately builds here, adds `out/.nojekyll` and publishes to `9router/9router.github.io` using a deploy key. Its configured push branches and path filters determine whether it runs on a given fork branch.

`NEXT_PUBLIC_BASE_PATH` is a build-time setting supplied to `basePath` and `assetPrefix`. Navigation components use Next `Link`, while `utils/markdown.js` does not implement a custom Markdown URL-prefix rewrite. Check both navigation and authored Markdown links when mounting under a prefix; changing the variable after export does not rewrite generated pages.

## Change-together checks

- New page: English content → shared navigation slug/labels → translations or intentional fallback → exported route.
- New language: language registry → navigation labels → index and page content → language links.
- URL-prefix changes: `next.config.mjs` → Markdown/navigation links → deployment build environment.
- No package-specific test script or test files are registered here. For content-only changes, check slugs, links and fallback behavior statically; a build generates outputs, and deployment publishes externally.
