// The guided tour, and the keyboard reference.
//
// Each step *performs* what it describes — the step about comparing versions
// switches version while you watch it, the step about the gate opens the gate.
// A tour that only points at things is a caption track; a tour that drives the
// product teaches it in the same number of words.

export function buildTour({ setTab, switchVariant, setSearch, canvasApi }) {
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
      title: 'Time, not just steady state',
      body: 'The discrete-event engine answers what the steady-state model cannot: retry storms that feed back, breakers that flap, and a service that saturates at unchanged traffic because its workers are all waiting on a slow dependency.',
      target: '.tabs',
      before: () => setTab('Chaos (DES)'),
    },
    {
      title: 'Everything from here',
      body: 'Press ⌘K for the command palette, ? for the keyboard map. Import your own plan JSON, HCL or Kubernetes manifests any time — nothing is uploaded anywhere.',
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
