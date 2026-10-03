// Tiny Express target for testing Tracegrab.
// No database, no build step — just enough handler logic to be worth breakpointing.
//
//   npm install          (installs express)
//   then in Kiro: "Tracegrab: Start Debugging (launch + panel)"
//
// Endpoints:
//   GET  /orders/:id        -> look up an order, compute a total (branch worth watching)
//   POST /orders            -> create an order from a JSON body (data transform worth watching)

const express = require('express');

const app = express();
app.use(express.json());

// Fake in-memory "database".
const ORDERS = {
  A1: { id: 'A1', items: [{ sku: 'pen', qty: 3, price: 1.5 }, { sku: 'pad', qty: 1, price: 4 }], status: 'open' },
  A2: { id: 'A2', items: [], status: 'open' }, // empty — the branch Tracegrab is great at catching
};

// A pure helper — a good place for a breakpoint to inspect the computed value.
function computeTotal(order) {
  const subtotal = order.items.reduce((sum, it) => sum + it.qty * it.price, 0);
  const discount = subtotal > 5 ? subtotal * 0.1 : 0; // <- branch: set a conditional breakpoint here
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

// --- Same math, two different styles, so you can watch the control flow in Tracegrab. ---

// FOR-LOOP style: breakpoint inside the loop and watch `subtotal` grow on each pass.
function computeTotalForLoop(order) {
  let subtotal = 0;
  for (let i = 0; i < order.items.length; i++) {   // <- breakpoint: step the loop, watch `i` and `subtotal`
    const it = order.items[i];
    subtotal += it.qty * it.price;
  }
  const discount = subtotal > 5 ? subtotal * 0.1 : 0;
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

// RECURSIVE style: breakpoint in the helper and watch the call stack build up, then unwind.
function sumItemsRecursive(items, index = 0) {
  if (index >= items.length) {                     // <- breakpoint: base case, inspect the stack depth here
    return 0;
  }
  const it = items[index];
  return it.qty * it.price + sumItemsRecursive(items, index + 1); // <- recursive call: step into it
}

function computeTotalRecursive(order) {
  const subtotal = sumItemsRecursive(order.items);
  const discount = subtotal > 5 ? subtotal * 0.1 : 0;
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

// GET /orders/:id — breakpoint the entry, then after computeTotal to watch the data.
app.get('/orders/:id', (req, res) => {
  const id = req.params.id;              // <- breakpoint: handler entry, inspect `id`
  const order = ORDERS[id];
  if (!order) {
    return res.status(404).json({ error: 'not_found', id });
  }
  const totals = computeTotal(order);    // <- breakpoint: inspect `totals`, step into computeTotal
  res.json({ ...order, ...totals });
});

// GET /orders/:id/loop — same total, computed with a for loop. Breakpoint inside computeTotalForLoop.
app.get('/orders/:id/loop', (req, res) => {
  const id = req.params.id;
  const order = ORDERS[id];
  if (!order) {
    return res.status(404).json({ error: 'not_found', id });
  }
  const totals = computeTotalForLoop(order);   // <- breakpoint: step into the for loop
  res.json({ ...order, ...totals, method: 'for-loop' });
});

// GET /orders/:id/recursive — same total, computed recursively. Breakpoint inside sumItemsRecursive.
app.get('/orders/:id/recursive', (req, res) => {
  const id = req.params.id;
  const order = ORDERS[id];
  if (!order) {
    return res.status(404).json({ error: 'not_found', id });
  }
  const totals = computeTotalRecursive(order); // <- breakpoint: step into the recursion
  res.json({ ...order, ...totals, method: 'recursive' });
});

// POST /orders — breakpoint to watch the body transform into a stored record.
app.post('/orders', (req, res) => {
  const body = req.body || {};           // <- breakpoint: inspect the incoming `body`
  const id = 'A' + (Object.keys(ORDERS).length + 1);
  const order = { id, items: body.items || [], status: 'open' };
  ORDERS[id] = order;
  res.status(201).json({ id, ...computeTotal(order) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`demo-target listening on http://127.0.0.1:${PORT}`);
  console.log('try:  curl http://127.0.0.1:' + PORT + '/orders/A1');
});
