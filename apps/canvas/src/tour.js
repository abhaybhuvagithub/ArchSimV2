// The guided tour, and the keyboard reference.
//
// Each step *performs* what it describes — the step about comparing versions
// switches version while you watch it, the step about the gate opens the gate.
// A tour that only points at things is a caption track; a tour that drives the
// product teaches it in the same number of words.

export function buildTour({ setTab, switchVariant, setSearch, canvasApi, setStepNumbers, setGallery }) {
  return [
    {
      title: 'This is a verdict, not a diagram',
      body: 'ArchSim answers one question: will this infrastructure change hold up? The bar at the top says so before you ask, and it is the same computation a pull request gets.',
      target: '.verdict .mark',
      before: () => { switchVariant('pr'); setTab('Gate') },
    },
    {
      title: 'Watch it move',
      body: 'Two versions of the same estate are loaded — main, and a pull request that halves the database and cuts the fleet. Switch between them and the verdict changes.',
      target: '.seg',
      before: () => switchVariant('pr'),
    },
    {
      title: 'A probability, not a guess',
      body: 'Every capacity figure is a prior with error bars, so the model cannot honestly say “p99 = 812ms”. It says how much of the sampled space holds. The marker is the pass threshold; the number beside it is what main managed.',
      target: '.deck .grid',
      before: () => setTab('Gate'),
      pad: 4,
    },
    {
      title: 'And the price of the repair',
      body: 'Failing a pull request is cheap. This says what the cheapest fix costs, against the saving the change was chasing — which is a decision somebody can actually make.',
      target: '.verdict .fixline',
    },
    {
      title: 'The canvas is a projection',
      body: 'These components came out of Terraform, not a drawing. Amber rings mark what this change moved. Dashed edges are inferences — hover one and it tells you why it exists and how confident it is.',
      target: '.stage',
      before: () => setTab('Simulate'),
      pad: 0,
    },
    {
      title: 'A hundred designs to start from',
      body: 'The palette adds one component at a time and wires it in for you — a database lands connected to the service that will read it, dashed because ArchSim inferred it. If you would rather start from a whole architecture, there are a hundred of them under Templates, each with its own workload and SLOs.',
      target: '#templates-btn',
      before: () => setTab('Simulate'),
    },
    {
      title: 'Hatched means guessed',
      body: 'A hatched component runs on a modelled prior rather than a measurement, and the gate samples it ±40%. Connect telemetry and one click replaces the prior with what production actually does — the band narrows and every future verdict sharpens.',
      target: '.palette',
    },
    {
      title: 'Components arrive wired in',
      body: 'Click a component in the palette, or drag it onto the canvas, and it lands connected: a database downstream of the service that will read it, a worker downstream of a queue. Dashed, because ArchSim guessed. Press C to wire in everything already stranded.',
      target: '.palette',
      before: () => setTab('Simulate'),
    },
    {
      title: 'And what it will not wire',
      body: 'Metrics sinks, log pipelines, secrets managers and audit trails get no automatic edge. They are real dependencies and they are not on the request path — wire one in and the simulator would route every request through it, invent queueing that does not exist, and price a component the traffic never touches.',
      target: '.palette',
    },
    {
      title: 'Arrange, with a number attached',
      body: 'Five layouts plus the one you have, each scored on edge crossings, overlaps, backward arrows and ink. The ranking is the answer, not a preference — and leaving it alone is a row in the table, because on a hand-arranged design the best algorithm sometimes loses.',
      target: '.arrangetable',
      before: () => setTab('Arrange'),
    },
    {
      title: 'The View menu',
      body: 'Arrange and Fit in one click, the three palettes carried over from ArchSim 1.x, and ①②③ step numbers — which put the request order back into a picture that otherwise shows only topology. Turning them on now.',
      target: '#view-menu',
      before: () => { setTab('Simulate'); setStepNumbers?.(true) },
    },
    {
      title: 'Time, not just steady state',
      body: 'The discrete-event engine answers what the steady-state model cannot: retry storms that feed back, breakers that flap, and a service that saturates at unchanged traffic because its workers are all waiting on a slow dependency.',
      target: '.tabs',
      before: () => setTab('Chaos'),
    },
    {
      title: 'The twin, and where the model is wrong',
      body: 'Point it at telemetry and production gets to disagree with the model in public: a ghost node is a service the traffic sees and your diagram does not, and calibration replaces a prior with what actually happened — which narrows the band on every future verdict.',
      target: '.tabs',
      before: () => setTab('Twin'),
    },
    {
      title: 'And back into the code',
      body: 'Every edit here becomes the smallest possible patch to the files it came from — byte ranges, not a regeneration. Comments, ordering and everything ArchSim did not model are left exactly as they were. Removals are proposed, never applied: deleting infrastructure is a decision a person makes.',
      target: '.tabs',
      before: () => setTab('Code'),
    },
    {
      title: 'Six ways in',
      body: 'Terraform plan JSON or raw HCL, Kubernetes manifests, CloudFormation — which is also how CDK is read, from what cdk synth wrote rather than from the TypeScript — Pulumi, and Helm charts. Format is detected from the content, so a file called stack.json does not have to be explained.',
      target: '.topactions',
      before: () => setTab('Simulate'),
    },
    {
      title: 'Built to be readable',
      body: 'Screen-reader mode, also under View, adds a reading of the diagram in request order, stronger focus outlines and no motion at all. An SVG of boxes and curves has no reading order; this states each hop instead.',
      target: '#view-menu',
    },
    {
      title: 'Everything from here',
      body: 'Press ⌘K for the command palette, ? for the keyboard map, L for a hundred architectures, G to run this again. Nothing you import is uploaded anywhere — the whole studio runs in this tab.',
      target: '.topactions',
      before: () => { setTab('Simulate'); setSearch('') },
    },
  ]
}

export const TOUR_STEPS = buildTour

export const SHORTCUTS = [
  { keys: '⌘K', what: 'Command palette' },
  { keys: '?', what: 'This help' },
  { keys: '/', what: 'Search components' },
  { keys: '1 – 5', what: 'Switch deck tab' },
  { keys: '⌘Z', what: 'Undo' },
  { keys: '⇧⌘Z', what: 'Redo' },
  { keys: 'F', what: 'Fit canvas to design' },
  { keys: '+ / −', what: 'Zoom in / out' },
  { keys: '0', what: 'Reset zoom' },
  { keys: 'M', what: 'Compare main / this PR' },
  { keys: 'T', what: 'Cycle theme' },
  { keys: 'G', what: 'Start the tour' },
  { keys: 'C', what: 'Connect every unconnected component' },
  { keys: 'L', what: 'Browse the template library' },
  { keys: 'A', what: 'Open the Arrange tab' },
  { keys: 'Backspace', what: 'Remove selected component' },
  { keys: '⌥ drag', what: 'Connect two components' },
  { keys: '⌘ click', what: 'Add to selection' },
  { keys: 'Esc', what: 'Close the topmost overlay' },
]
