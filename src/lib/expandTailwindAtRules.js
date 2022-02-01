import LRU from 'quick-lru'
import * as sharedState from './sharedState'
import { generateRules } from './generateRules'
import bigSign from '../util/bigSign'
import log from '../util/log'
import cloneNodes from '../util/cloneNodes'
import { defaultExtractor } from './defaultExtractor'

let env = sharedState.env

const builtInExtractors = {
  DEFAULT: defaultExtractor,
}

const builtInTransformers = {
  DEFAULT: (content) => content,
  svelte: (content) => content.replace(/(?:^|\s)class:/g, ' '),
}

function getExtractor(tailwindConfig, fileExtension) {
  let extractors = tailwindConfig.content.extract

  return (
    extractors[fileExtension] ||
    extractors.DEFAULT ||
    builtInExtractors[fileExtension] ||
    builtInExtractors.DEFAULT
  )
}

function getTransformer(tailwindConfig, fileExtension) {
  let transformers = tailwindConfig.content.transform

  return (
    transformers[fileExtension] ||
    transformers.DEFAULT ||
    builtInTransformers[fileExtension] ||
    builtInTransformers.DEFAULT
  )
}

let extractorCache = new WeakMap()

// Scans template contents for possible classes. This is a hot path on initial build but
// not too important for subsequent builds. The faster the better though — if we can speed
// up these regexes by 50% that could cut initial build time by like 20%.
function getClassCandidates(content, extractor, candidates, seen) {
  if (!extractorCache.has(extractor)) {
    extractorCache.set(extractor, new LRU({ maxSize: 25000 }))
  }

  for (let line of content.split('\n')) {
    line = line.trim()

    if (seen.has(line)) {
      continue
    }
    seen.add(line)

    if (extractorCache.get(extractor).has(line)) {
      for (let match of extractorCache.get(extractor).get(line)) {
        candidates.add(match)
      }
    } else {
      let extractorMatches = extractor(line).filter((s) => s !== '!*')
      let lineMatchesSet = new Set(extractorMatches)

      for (let match of lineMatchesSet) {
        candidates.add(match)
      }

      extractorCache.get(extractor).set(line, lineMatchesSet)
    }
  }
}

function buildStylesheet(rules, context) {
  let sortedRules = rules.sort(([a], [z]) => bigSign(a - z))

  let returnValue = {
    base: new Set(),
    defaults: new Set(),
    components: new Set(),
    utilities: new Set(),
    variants: new Set(),

    // All the CSS that is not Tailwind related can be put in this bucket. This
    // will make it easier to later use this information when we want to
    // `@apply` for example. The main reason we do this here is because we
    // still need to make sure the order is correct. Last but not least, we
    // will make sure to always re-inject this section into the css, even if
    // certain rules were not used. This means that it will look like a no-op
    // from the user's perspective, but we gathered all the useful information
    // we need.
    user: new Set(),
  }

  for (let [sort, rule] of sortedRules) {
    if (sort >= context.minimumScreen) {
      returnValue.variants.add(rule)
      continue
    }

    if (sort & context.layerOrder.base) {
      returnValue.base.add(rule)
      continue
    }

    if (sort & context.layerOrder.defaults) {
      returnValue.defaults.add(rule)
      continue
    }

    if (sort & context.layerOrder.components) {
      returnValue.components.add(rule)
      continue
    }

    if (sort & context.layerOrder.utilities) {
      returnValue.utilities.add(rule)
      continue
    }

    if (sort & context.layerOrder.user) {
      returnValue.user.add(rule)
      continue
    }
  }

  return returnValue
}

/**
 *
 * @param {import('postcss').Document} doc
 * @param {Record<"base" | "components" | "utilities" | "variants", import('postcss').Node | null>} layerNodes
 */
function findRootInDocument(doc, layerNodes) {
  // We only append variants to the end of the tree if there's no explicit variants node.
  // In which case we don't need to worry about this
  if (layerNodes.variants !== null) {
    return doc
  }

  // The ideal solution would be to use the `.root()` on the utility
  // or component nodes. However we cannot rely on that actually
  // pointing to the root node. Sometimes it'll point to the
  // tailwind at-rule itself — so we have to do extra work.

  // We need to find the root node associated with the tailwind rules.
  // However, it is *possible* that the nodes are split across
  // multiple roots in the same document (though unlikely)

  // Given that there can be multiple roots we will find all
  // of the ones that are associated with the tailwind rules.
  let roots = doc.nodes.filter((node) => {
    if (node.type !== 'root') {
      return false
    }

    if (layerNodes.components !== null && node.index(layerNodes.components) !== -1) {
      return true
    }

    if (layerNodes.utilities !== null && node.index(layerNodes.utilities) !== -1) {
      return true
    }

    return false
  })

  // And pick the last one if it exists since
  // this is most likely the one we will want
  let root = roots[roots.length - 1]

  if (!root) {
    log.warn('postcss-document-root-missing', [
      `Your project is using PostCSS Document nodes however Tailwind CSS was unable to find the root node.`,
      `Variants may be appended to the end of the document instead of where you expect them. Please open an issue with a reproduction!`,
    ])

    return doc
  }

  return root
}

/**
 * @returns {(root: import('postcss').Root | import('postcss').Document) => void}
 */
export default function expandTailwindAtRules(context) {
  return (root) => {
    let layerNodes = {
      base: null,
      components: null,
      utilities: null,
      variants: null,
    }

    root.walkAtRules((rule) => {
      // Make sure this file contains Tailwind directives. If not, we can save
      // a lot of work and bail early. Also we don't have to register our touch
      // file as a dependency since the output of this CSS does not depend on
      // the source of any templates. Think Vue <style> blocks for example.
      if (rule.name === 'tailwind') {
        if (Object.keys(layerNodes).includes(rule.params)) {
          layerNodes[rule.params] = rule
        }
      }
    })

    if (Object.values(layerNodes).every((n) => n === null)) {
      return root
    }

    // ---

    // Experiemntal PostCSS document node support
    if (root.type === 'document') {
      root = findRootInDocument(root, layerNodes)
    }

    // ---

    // Find potential rules in changed files
    let candidates = new Set(['*'])
    let seen = new Set()

    env.DEBUG && console.time('Reading changed files')

    for (let { content, extension } of context.changedContent) {
      let transformer = getTransformer(context.tailwindConfig, extension)
      let extractor = getExtractor(context.tailwindConfig, extension)
      getClassCandidates(transformer(content), extractor, candidates, seen)
    }

    env.DEBUG && console.timeEnd('Reading changed files')

    // ---

    // Generate the actual CSS
    let classCacheCount = context.classCache.size

    env.DEBUG && console.time('Generate rules')
    let rules = generateRules(candidates, context)
    env.DEBUG && console.timeEnd('Generate rules')

    // We only ever add to the classCache, so if it didn't grow, there is nothing new.
    env.DEBUG && console.time('Build stylesheet')
    if (context.stylesheetCache === null || context.classCache.size !== classCacheCount) {
      for (let rule of rules) {
        context.ruleCache.add(rule)
      }

      context.stylesheetCache = buildStylesheet([...context.ruleCache], context)
    }
    env.DEBUG && console.timeEnd('Build stylesheet')

    let {
      defaults: defaultNodes,
      base: baseNodes,
      components: componentNodes,
      utilities: utilityNodes,
      variants: screenNodes,
    } = context.stylesheetCache

    // ---

    // Replace any Tailwind directives with generated CSS

    if (layerNodes.base) {
      layerNodes.base.before(cloneNodes([...baseNodes, ...defaultNodes], layerNodes.base.source))
      layerNodes.base.remove()
    }

    if (layerNodes.components) {
      layerNodes.components.before(cloneNodes([...componentNodes], layerNodes.components.source))
      layerNodes.components.remove()
    }

    if (layerNodes.utilities) {
      layerNodes.utilities.before(cloneNodes([...utilityNodes], layerNodes.utilities.source))
      layerNodes.utilities.remove()
    }

    // We do post-filtering to not alter the emitted order of the variants
    const variantNodes = Array.from(screenNodes).filter((node) => {
      const parentLayer = node.raws.tailwind?.parentLayer

      if (parentLayer === 'components') {
        return layerNodes.components !== null
      }

      if (parentLayer === 'utilities') {
        return layerNodes.utilities !== null
      }

      return true
    })

    if (layerNodes.variants) {
      layerNodes.variants.before(cloneNodes(variantNodes, layerNodes.variants.source))
      layerNodes.variants.remove()
    } else if (variantNodes.length > 0) {
      root.append(cloneNodes(variantNodes, root.source))
    }

    // If we've got a utility layer and no utilities are generated there's likely something wrong
    const hasUtilityVariants = variantNodes.some(
      (node) => node.raws.tailwind?.parentLayer === 'utilities'
    )

    if (layerNodes.utilities && utilityNodes.size === 0 && !hasUtilityVariants) {
      log.warn('content-problems', [
        'No utility classes were detected in your source files. If this is unexpected, double-check the `content` option in your Tailwind CSS configuration.',
        'https://tailwindcss.com/docs/content-configuration',
      ])
    }

    // ---

    if (env.DEBUG) {
      console.log('Potential classes: ', candidates.size)
      console.log('Active contexts: ', sharedState.contextSourcesMap.size)
    }

    // Clear the cache for the changed files
    context.changedContent = []

    // Cleanup any leftover @layer atrules
    root.walkAtRules('layer', (rule) => {
      if (Object.keys(layerNodes).includes(rule.params)) {
        rule.remove()
      }
    })
  }
}
