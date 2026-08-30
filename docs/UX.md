# The studio: 100 candidate features, and which ones shipped

## Two notes on the brief before the list

**"Google standards" and "the v1 theme" are different requests, and both are
honoured — at different layers.** Material Design and Apple's HIG are opposed
design languages; adopting Material's palette and shapes would have thrown away
the v1 identity that was asked for one commit earlier. So the split is:

- **Identity stays v1's** — pill controls, generous radii, the radial canvas,
  and — since the typography pass — v1's actual type system: IBM Plex Sans for
  body, Space Grotesk for headings and the wordmark, IBM Plex Mono for code,
  figures and every small label, uppercase at .09em tracking. Palettes are v1's
  three: Kesar, Glow, Lilac.

  > This bullet used to say "Apple palette, system type", which was wrong. I had
  > described v1 from memory rather than from the page. Reading the live site
  > settled it, and the correction is left visible here because a design doc
  > that quietly rewrites its own history is worth less than one that does not.
- **Behaviour becomes Google's** — Material 3's motion system (emphasised and
  standard easing, a real duration scale, shared-axis transitions), state layers
  on every interactive surface, elevation used to mean depth rather than
  decoration, snackbars, a command surface, and the accessibility floor
  (WCAG 2.2 AA contrast, 44px targets, visible focus, live regions, full
  keyboard operation, `prefers-reduced-motion`).

That is the useful reading of "Google standards": not a skin, a standard of
finish.

**Not all hundred should be built.** A hundred features would be the wrong
answer to "this tool isn't useful" — that complaint is about the first thirty
seconds, not the surface area. The list below is honest about it: 73 shipped,
27 deliberately deferred with the reason. Several of the deferred ones are
listed precisely because they *sound* good and would make the tool worse.

---

## Shipped

### Motion and feedback (Material 3 motion)
1. Duration scale — short/medium/long tokens, no ad-hoc milliseconds
2. Emphasised easing for entrances, standard easing for exits
3. Shared-axis transition between deck panels
4. Verdict bar cross-fades between states instead of snapping
5. Distribution bars animate to their value on first paint
6. Node hover state layer (Material state-layer opacity, not a colour swap)
7. Node press/active feedback
8. Ripple-free but pressure-aware buttons — translate on `:active`
9. Skeleton shimmer while the gate samples
10. Toast/snackbar system with a queue and an action slot
11. Toasts announce through `aria-live` for screen readers
12. Canvas selection ring animates in
13. Panel content staggers in on tab change
14. Every animation is disabled under `prefers-reduced-motion`
15. Focus ring transitions, never jumps

### The guided tour
16. Multi-step product tour with a spotlight cut-out
17. Tour steps are anchored to real elements and reposition on resize
18. Keyboard-operable: arrows, Enter, Escape
19. Progress indicator with step count
20. Tour can be resumed from the help menu
21. "Seen" state persists per browser, so it does not nag
22. Each step performs its own demonstration (switches variant, opens a tab)
23. Skip control on every step
24. Tour respects reduced motion

### Command surface
25. Command palette on ⌘K / Ctrl-K
26. Fuzzy matching over every action in the app
27. Commands grouped by area with keyboard hints
28. Arrow-key navigation and Enter to run
29. Recently used commands float to the top
30. Palette is reachable from a visible button, not only a shortcut

### Keyboard
31. `?` opens a shortcut reference
32. `⌘Z` / `⇧⌘Z` undo and redo
33. `1`–`5` switch deck tabs
34. `/` focuses component search
35. `F` fits the canvas to the design
36. `+` / `-` / `0` zoom in, out, reset
37. `Escape` closes any overlay, in order
38. Skip-to-content link for keyboard users
39. Focus is trapped inside modals and returned on close
40. Every control reachable by Tab, in reading order

### Canvas
41. Wheel and pinch zoom, anchored at the pointer
42. Drag-to-pan on empty canvas
43. Fit-to-view, with padding
44. Zoom level indicator and controls
45. Minimap with a live viewport rectangle
46. Click the minimap to jump
47. Component search that dims non-matches rather than hiding them
48. Changed-node highlighting when comparing against `main`
49. Edge hover reveals its reason and confidence
50. Node tooltips carry provenance, capacity and binding
51. Grid alignment on drag
52. Multi-select with shift-click
53. Delete key removes the selection (as a removal proposal, never from code)

### The verdict and the gate
54. Verdict computes on load, not behind a button
55. `main` / `this PR` comparison
56. Distribution bar per SLO with the pass threshold marked
57. "was N% on main" beside every row
58. Per-scenario breakdown on demand
59. The priced fix, against the saving the change was chasing
60. Copy-the-PR-comment button — the exact markdown CI would post

### State and persistence
61. Undo/redo across every design edit
62. Autosave of the working design to the browser
63. Restore prompt on return, never a silent overwrite
64. Theme choice persists (system / light / dark)
65. Deck tab and canvas position persist

### Export
66. Download the IR as `archsim.lock.json`
67. Download the gate report as markdown
68. Export the canvas as SVG
69. Export the canvas as PNG at 2× for slides
70. Copy a share link that round-trips the design through the URL

### Accessibility and polish
71. WCAG AA contrast in both themes, checked against the tokens
72. Live region announcing verdict changes
73. Empty and error states written as sentences, not shrugs

---

## Deliberately deferred

Each of these was considered and left out. Where the reason is "would make the
tool worse", that is the whole reason.

74. **Collaborative cursors** — no backend, and a fake presence indicator is a lie
75. **Comment threads on nodes** — same
76. **Node grouping / containers** — the IR has no grouping concept; adding one to
    the canvas alone would desynchronise the projections
77. **Auto-layout algorithms (force-directed, dagre)** — the layered layout follows
    tier rank, which encodes traffic direction; a force layout would look
    livelier and mean less
78. **Animated packet flow along edges** — the classic architecture-demo flourish.
    It implies a per-request animation the simulator is not computing, so it
    would be decoration pretending to be data
79. **3D / isometric canvas view** — same objection, more expensive
80. **Dark-mode-only neon theme** — conflicts with the identity just adopted
81. **Custom node icons per cloud vendor** — licensing, and the catalog kind is the
    thing that matters
82. **Drag-and-drop file import onto the canvas** — the import button is one click
    and drop targets on a drag-to-pan canvas fight each other
83. **Inline editing of node labels on the canvas** — the inspector already owns it
84. **Right-click context menus** — duplicates the command palette; two ways to do
    everything is a maintenance tax
85. **Node search with regex** — over-serving; substring is the real need
86. **Saved views / bookmarks** — no persistence layer worth the complexity yet
87. **Multi-file IaC import in the browser** — the CLI is the right home for that
88. **Live Terraform plan streaming** — needs a backend
89. **In-browser terminal** — a demo, not a tool
90. **Onboarding video** — a tour that does the thing beats a video about it
91. **Tooltips on every single control** — noise; only non-obvious controls get one
92. **Confetti on a passing gate** — a passing gate is the expected state
93. **Sound effects** — no
94. **AI assistant panel** — without a model behind it, a prompt box is a dead end
95. **Template gallery of 97 designs** — that is v1's job and v1 does it well;
    duplicating it here would blur what v2 is for
96. **User accounts** — no backend
97. **Charts library for the DES timeline** — the sparkline is hand-drawn in 40
    lines; a charting dependency would be larger than the engine it plots
98. **i18n** — premature with one user-facing surface still moving weekly
99. **Offline service worker** — the page is already one static bundle
100. **Mobile drag-to-edit** — the canvas is a desktop surface; mobile gets a
     read-only responsive layout instead, which is honest about the device

---

## What still isn't good enough

Named here so it stays visible rather than getting lost in a list of wins:

- **Node-scoped SLOs are still approximated.** `slo.js` derives a per-node p99 as
  `latency × 3`. System-scoped SLOs are properly derived; per-node ones are a
  placeholder and should not be leaned on.
- **The plan-JSON path has never been driven by a live `terraform plan`.** Every
  plan fixture is generated. That is the next thing worth measuring.
- **The twin's synthetic source is a demo.** It exercises the whole path, which is
  why it exists, but no real Prometheus has been pointed at this yet.

---

## Shipped after opening the live URL

The list above was written against a development server. Opening the deployed
page in a real browser pane found three things no local run had:

- **The page scrolled sideways on a phone.** The top bar refused to wrap and
  pushed the document 355px past the viewport, putting the right-hand controls
  out of reach. It now wraps below 720px; below 520px the tagline, the commit
  hash and the minimap step out, and the tab strip scrolls on its own.
- **The canvas was blank in a short window.** The deck held a fixed 320px, which
  in a 480px-tall window left the stage 43 pixels. The deck now takes a share of
  the height with its old value as a cap.
- **The viewBox was measured from the wrong element.** It came from the canvas
  wrapper, but the SVG carries a `min-height`, so on a short stage the wrapper is
  clipped while the drawing surface stays taller — a small viewBox mapped onto a
  large element drew everything several times too big and off-screen. It is now
  measured from the SVG, and a `ResizeObserver` refits when the stage changes
  size, unless the reader has already panned or zoomed.

Verified at 1500×940, 800×1104, 800×600, 1000×480 and 430×900: every node inside
the visible stage, no stage scrollbar, no page overflow, no console errors in
either colour scheme.

The general lesson is worth keeping: none of these three reproduce at a desktop
window size, and all three were the first thing a visitor would have seen.
