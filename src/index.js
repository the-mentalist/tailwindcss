import setupTrackingContext from './lib/setupTrackingContext'
import processTailwindFeatures from './processTailwindFeatures'
import { env } from './lib/sharedState'

module.exports = function tailwindcss(configOrPath) {
  return {
    postcssPlugin: 'tailwindcss',
    plugins: [
      env.DEBUG &&
        function (root) {
          console.log('\n')
          console.time('JIT TOTAL')
          return root
        },
      function (root, result) {
        let context = setupTrackingContext(configOrPath)

        let roots = root.type === 'document'
          ? root.nodes.filter(node => node.type === 'root')
          : [root]

        // Process each root node separately like it was it's own CSS file
        for (const root of roots) {
          processTailwindFeatures(context)(root, result)
        }
      },
      env.DEBUG &&
        function (root) {
          console.timeEnd('JIT TOTAL')
          console.log('\n')
          return root
        },
    ].filter(Boolean),
  }
}

module.exports.postcss = true
