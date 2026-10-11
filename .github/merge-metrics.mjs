// Merge the base metrics SVG and the notable-contributions SVG into a single file.
//
// metrics renders each invocation independently and sets the root SVG height to
// the exact content height (measured with puppeteer). Since the notable render is
// generated with `base: ""`, it contains only the notable <section> (no header and
// no footer). Inserting that section before the base render's <footer> increases
// the content height by exactly the notable render's height, so the merged height
// is simply the sum of both measured heights.
//
// The notable GraphQL query intermittently times out on GitHub's side, so this
// script is defensive: if the notable render failed (or is missing), it reuses the
// last good notable section from the previously committed file (whose height is
// recorded in a comment) instead of publishing the "Unexpected error" card.
//
// usage: node merge-metrics.mjs <base.svg> <notable.svg> <out.svg>

import fs from "fs"

const [mainPath, notablePath, outPath] = process.argv.slice(2)
if (!mainPath || !notablePath || !outPath) {
  console.error("usage: merge-metrics.mjs <base.svg> <notable.svg> <out.svg>")
  process.exit(1)
}

const main = fs.readFileSync(mainPath, "utf8")
const HEIGHT_COMMENT = /<!--\s*metrics:notable-height (\d+)\s*-->/

// Read the root <svg> height attribute (the first <svg> in the document)
function rootHeight(svg) {
  const start = svg.indexOf("<svg")
  const end = svg.indexOf(">", start)
  const match = /\sheight="([\d.]+)"/.exec(svg.slice(start, end))
  if (!match) throw new Error("could not find root <svg> height")
  return Number(match[1])
}

// Extract the inner HTML of the items-wrapper div (the rendered content)
function wrapperContent(svg) {
  const open = /<div[^>]*class="items-wrapper"[^>]*>/.exec(svg)
  if (!open) throw new Error("could not find items-wrapper")
  const contentStart = open.index + open[0].length
  const endMarker = svg.indexOf('id="metrics-end"')
  if (endMarker < 0) throw new Error("could not find metrics-end")
  const close = svg.lastIndexOf("</div>", endMarker)
  if (close < 0) throw new Error("could not find items-wrapper closing tag")
  return svg.slice(contentStart, close)
}

// Extract the notable <section> (the one containing the given marker)
function notableSection(svg) {
  const marker = svg.indexOf("Notable contributions")
  if (marker < 0) return null
  const start = svg.lastIndexOf("<section", marker)
  if (start < 0) return null
  let depth = 0
  const re = /<section\b[^>]*>|<\/section>/g
  re.lastIndex = start
  let match
  while ((match = re.exec(svg))) {
    depth += match[0] === "</section>" ? -1 : 1
    if (depth === 0) return svg.slice(start, match.index + match[0].length)
  }
  return null
}

// The notable plugin renders an error placeholder when its query fails
const isError = (section) => /class="field error"/.test(section)

// Prefer the freshly rendered notable section
let notable = null
let notableHeight = null
let source = null
if (fs.existsSync(notablePath)) {
  const rendered = fs.readFileSync(notablePath, "utf8")
  const section = notableSection(wrapperContent(rendered))
  if (section && !isError(section)) {
    notable = section
    notableHeight = rootHeight(rendered)
    source = "fresh"
  }
}

// Otherwise fall back to the previous good render
let previous = null
try {
  previous = fs.readFileSync(outPath, "utf8")
} catch {}
if (!notable && previous) {
  const section = notableSection(previous)
  const height = HEIGHT_COMMENT.exec(previous)
  if (section && !isError(section) && height) {
    notable = section
    notableHeight = Number(height[1])
    source = "previous"
  }
}

const mainHeight = rootHeight(main)

let result
if (notable) {
  // Insert the notable section right before the base render's footer
  const footerIndex = main.indexOf("<footer>")
  if (footerIndex < 0) throw new Error("could not find footer in base render")
  const merged = main.slice(0, footerIndex) + notable + "\n            " + main.slice(footerIndex)
  // Set the merged root height, and record the notable height for future fallbacks
  const tagStart = merged.indexOf("<svg")
  const tagEnd = merged.indexOf(">", tagStart)
  const mergedTag = merged
    .slice(tagStart, tagEnd)
    .replace(/\sheight="[\d.]+"/, ` height="${mainHeight + notableHeight}"`)
  const withHeight = merged.slice(0, tagStart) + mergedTag + merged.slice(tagEnd)
  result = withHeight.replace("</svg>", `    <!-- metrics:notable-height ${notableHeight} -->\n</svg>`)
  console.error(`notable from ${source}: height ${mainHeight} + ${notableHeight} = ${mainHeight + notableHeight}`)
} else {
  // No good notable available anywhere: publish base metrics without the section
  // rather than showing "Unexpected error"
  result = main
  console.error(`notable unavailable: publishing base metrics only (height ${mainHeight})`)
}

// Skip rewriting when nothing but the generation timestamp changed
const normalize = (svg) => svg.replace(/Last updated [^<]+/, "Last updated ...")
if (previous && normalize(previous) === normalize(result)) {
  console.error("render unchanged")
  process.exit(0)
}

fs.writeFileSync(outPath, result)
console.error(`wrote ${outPath}`)
