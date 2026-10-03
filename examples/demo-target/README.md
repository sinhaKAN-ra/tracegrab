# Tracegrab demo target

A tiny API you can open in your editor to try the **Tracegrab** extension end to end:
fire a request → pause at a breakpoint in the handler → watch the live data flow.

Two servers, so you can see **both** supported languages. Pick one:

| File | Language | Needs |
|------|----------|-------|
| `server.js` | Node / Express | `npm install` (Node's debugger is built in) |
| `server.py` | Python (stdlib `http.server`, **no framework**) | `pip install debugpy` |

> Tracegrab supports **Node (always)** and **Python (when `debugpy` is installed in the
> target's environment)**. No web framework is required — a plain script works for
> breakpoint/step/inspect; a server (any kind) adds the "fire an API call" part.

---

## Node (Express) — fastest, nothing extra to install

```bash
cd examples/demo-target
npm install          # installs express
```

1. Open **this `examples/demo-target` folder** in Kiro (`File → Open Folder`).
2. Command Palette (`Cmd+Shift+P`) → **`Tracegrab: Start Debugging (launch + panel)`**
   → pick **"Debug demo-target (Node)"**. This launches the server *under the debugger*
   and opens the panel in one step.
3. Confirm it attached: the status bar turns **orange** and a floating debug toolbar appears.
4. Set a breakpoint in `server.js` — try the `computeTotal` line or the handler entry (click the gutter).
5. Fire a request from a terminal:
   ```bash
   curl http://127.0.0.1:3000/orders/A1
   ```
   The request **hangs** (that's good — it's paused at your breakpoint), and the Tracegrab
   panel populates with the call map + data inspector. Step/continue from the toolbar or the panel.

Try `curl http://127.0.0.1:3000/orders/A2` to watch the empty-items branch (`discount = 0`).

---

## Python (stdlib, no framework)

```bash
pip install debugpy        # the only requirement
```

1. Open this folder in Kiro.
2. Command Palette → **`Tracegrab: Start Debugging (launch + panel)`** → pick **"Debug demo-target (Python)"**.
3. Set a breakpoint in `server.py` (`compute_total`, or the handler entry).
4. Fire a request:
   ```bash
   curl http://127.0.0.1:3001/orders/A1
   ```

If the panel shows nothing for Python, `debugpy` isn't installed in the interpreter the
config launched — run `pip install debugpy` in that same environment.

---

## The panel is empty until a request pauses — that is expected, not a bug.
