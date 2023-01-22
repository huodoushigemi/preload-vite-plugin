import { IndexHtmlTransformContext, PluginOption, ResolvedConfig } from 'vite'
import { JSDOM } from 'jsdom'
import { extname } from 'path'

interface Options {
  include?: string[] | 'initial' | 'allChunks' | 'asyncChunks'
  rel?: string
  as?: string | ((href: string) => string)
  fileBlacklist?: RegExp[]
  media?: string
}

function flat(enters: string[] | undefined, fn: (filename: string) => string[], arr: string[] = []) {
  const chunks = (enters ?? []).filter(e => !arr.includes(e))
  arr.push(...chunks)
  chunks.forEach(e => {
    flat(fn(e), fn, arr)
  })
  return arr
}

function extractChunks(ctx: IndexHtmlTransformContext, include: Options['include']): string[] {
  const bundle = ctx.bundle!
  const chunk = ctx.chunk!

  if (include === 'asyncChunks' || include === undefined) {
    const initialChunks = extractChunks(ctx, 'initial')
    return flat(chunk.dynamicImports, fn => {
      // import('.*.css') will result in not being found in bundle
      const output = bundle[fn]
      if (!output) return []
      return output.type === 'chunk' ? [...new Set([...output.imports, ...output.dynamicImports])] : []
    }).filter(e => !initialChunks.includes(e))
  }
  if (include === 'initial') {
    return flat(chunk.imports, fn => {
      const output = bundle[fn]
      return output.type === 'chunk' ? output.imports : []
    }).concat(chunk.fileName)
  }
  if (include === 'allChunks') {
    return Object.values(bundle).map(e => e.fileName)
  }
  if (Array.isArray(include)) {
    return Object.values(bundle)
      .filter(e => e.name && include.includes(e.name))
      .map(e => e.fileName)
  }
  return []
}

function determineAsValue(href: string, optionsAs: Options['as']) {
  switch (typeof optionsAs) {
    case 'string':
      return optionsAs
    case 'function':
      return optionsAs(href)
    case 'undefined':
      const url = new URL(href, 'https://example.com')
      const extension = extname(url.pathname)
      if (extension === '.css') return 'style'
      if (extension === '.woff2') return 'font'
      return 'script'
    default:
      throw new Error(`The 'as' option isn't set to a recognized value: ${optionsAs}`)
  }
}

function getExisting(html: string) {
  const document = new JSDOM(html).window.document
  const map = Array.prototype.map
  // prettier-ignore
  return [
    ...map.call(document.querySelectorAll('link'), e => e.href),
    ...map.call(document.querySelectorAll('script[src]'), e => e.src)
  ]
}

export default function (_options?: Options) {
  const options: Options = {
    rel: 'modulepreload',
    include: 'asyncChunks',
    fileBlacklist: [/\.map/],
    ..._options
  }

  let config: ResolvedConfig
  return {
    name: 'preload-vite-plugin',
    apply: 'build',
    configResolved(_config) {
      config = _config
    },
    transformIndexHtml: {
      enforce: 'post',
      transform(html, ctx) {
        const { bundle } = ctx
        if (!bundle) return

        const seen = new Set(getExisting(html))

        const np = (e: string) => `${config.base.replace(/\/$/, '')}/${e}`

        const arr = extractChunks(ctx, options.include)
          .filter(e => bundle[e])
          .filter(e => !seen.has(np(e)))
          .filter(e => !options.fileBlacklist || options.fileBlacklist.some(reg => !reg.test(e)))

        const links = arr.map(e => {
          const attrs: any = {
            rel: options.rel,
            href: np(e)
          }
          if (options.media) attrs.media = options.media
          if (options.rel === 'preload') attrs.as = determineAsValue(attrs.href, options.as)
          if (attrs.as === 'font') attrs.crossorigin = 'anonymous'
          return attrs
        })

        return {
          tags: links?.map(e => ({
            tag: 'link',
            attrs: e,
            injectTo: 'head'
          }))
        }
      }
    }
  } as PluginOption
}
