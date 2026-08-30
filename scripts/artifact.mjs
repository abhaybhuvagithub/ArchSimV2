// Fold the built studio into one self-contained page for the artifact viewer.
//
// The viewer wraps the file in its own <!doctype>/<head>/<body>, so what we emit
// is page content only: a title, the stylesheet, the mount point, and the
// bundle. External hosts are blocked there, so nothing may stay a <link> or a
// <script src>.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'apps/canvas/dist')
const assets = readdirSync(join(dist, 'assets'))
const css = assets.find((f) => f.endsWith('.css'))
const js = assets.find((f) => f.endsWith('.js') && !f.endsWith('.map'))
if (!css || !js) throw new Error('build first: npm run build -w apps/canvas')

const out = process.argv[2] || join(root, 'archsim-studio.html')
const style = readFileSync(join(dist, 'assets', css), 'utf8')
// A literal </script> anywhere in the bundle would close the tag early.
const script = readFileSync(join(dist, 'assets', js), 'utf8').replace(/<\/script>/gi, '<\\/script>')

writeFileSync(out, `<title>ArchSim Studio</title>
<meta name="description" content="Judge an infrastructure change before it merges: one IR projected onto a canvas, the Terraform it came from, and production." />

<!-- Google Fonts is the one external host the artifact CSP admits, and the
     typography is half of what makes this look like the same product as
     ArchSim 1.x. Every family has a real fallback stack in the CSS, so the page
     is legible before these arrive and on a machine that never gets them. -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap" />

<style>
${style}
</style>

<div id="root"></div>

<script type="module">
${script}
</script>
`)
console.log(`${out} — ${(readFileSync(out).length / 1024).toFixed(0)} kB`)
