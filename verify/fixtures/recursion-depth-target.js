// Standalone self-recursion fixture for verify/recursion-depth.test.mjs.
//
// Mirrors examples/demo-target/server.js `sumItemsRecursive` so the collector
// can breakpoint the recursive-call line and record a REAL, adapter-realistic
// increasing-depth trace through NodeCdpDriver (no Express/HTTP). Each recursive
// activation is a DISTINCT, deeper call frame, so the recorded stackDepth MUST
// strictly increase frame-over-frame.
//
// Keep the recursive self-call on its own line so the breakpoint lands once per
// activation; the test resolves that line by reading this file.

function sumItemsRecursive(items, index = 0) {
  if (index >= items.length) {
    return 0;
  }
  const it = items[index];
  const rest = sumItemsRecursive(items, index + 1); // RECURSION_LINE: breakpoint here
  return it.qty * it.price + rest;
}

function computeTotalRecursive(items) {
  return sumItemsRecursive(items);
}

// 4 items -> activations at index 0,1,2,3 plus the base case (index 4): the
// sumItemsRecursive frame reappears at strictly increasing depth each time.
const items = [
  { sku: 'pen', qty: 3, price: 1.5 },
  { sku: 'pad', qty: 1, price: 4 },
  { sku: 'ink', qty: 2, price: 2 },
  { sku: 'clip', qty: 5, price: 0.5 },
];

const total = computeTotalRecursive(items);
console.log('total=' + total);
