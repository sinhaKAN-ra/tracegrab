#!/usr/bin/env python3
"""
Tiny Python API target for testing Tracegrab — stdlib only, NO framework.

Proves the point: Tracegrab's Python support is at the DEBUGGER level (debugpy),
not the framework level. No Django, no Flask. The one requirement is debugpy in
THIS interpreter:

    pip install debugpy

Then in Kiro:  "Tracegrab: Start Debugging (launch + panel)" and pick the Python config.

Endpoints:
    GET /orders/<id>   -> look up an order, compute a total (branch worth watching)
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json

ORDERS = {
    "A1": {"id": "A1", "items": [{"sku": "pen", "qty": 3, "price": 1.5},
                                 {"sku": "pad", "qty": 1, "price": 4}], "status": "open"},
    "A2": {"id": "A2", "items": [], "status": "open"},  # empty — the branch to catch
}


def compute_total(order):
    subtotal = sum(it["qty"] * it["price"] for it in order["items"])
    discount = subtotal * 0.1 if subtotal > 5 else 0  # <- breakpoint: inspect the branch
    total = subtotal - discount
    return {"subtotal": subtotal, "discount": discount, "total": total}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "orders":
            order_id = parts[1]                 # <- breakpoint: handler entry, inspect order_id
            order = ORDERS.get(order_id)
            if not order:
                return self._send(404, {"error": "not_found", "id": order_id})
            totals = compute_total(order)       # <- breakpoint: inspect totals
            return self._send(200, {**order, **totals})
        self._send(404, {"error": "no_route", "path": self.path})

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # quiet


if __name__ == "__main__":
    port = 3001
    print(f"python demo-target listening on http://127.0.0.1:{port}")
    print(f"try:  curl http://127.0.0.1:{port}/orders/A1")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
