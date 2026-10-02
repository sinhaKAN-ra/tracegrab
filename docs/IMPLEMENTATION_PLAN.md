# AI-Assisted Code Testing & Debugging Visualizer

> **Outdated — read `docs/FLOW_DEBUGGER_DESIGN.md` instead.** This file describes the
> original "AI Auditor / confidence score" direction, which has been superseded by the
> interactive API-flow test debugger. The canonical plan, current build phases, and the
> latest landed work (npm/`npx` packaging + `get_capabilities`, and interactive headless
> debugging for Node + Python) live in `docs/FLOW_DEBUGGER_DESIGN.md`. Kept for history.

This document outlines the architecture, implementation plan, and deployment strategy for a developer tool designed to visually trace, analyze, and validate AI-generated code during execution.

## Goal Description
To build a system that augments traditional debugging by visually tracking data flow, highlighting execution paths in real-time, and using AI to automatically evaluate the code for hallucinations, optimality, and adherence to guidelines. This increases developer confidence before code review.

## Architecture & Technology Stack

### 1. VS Code Extension (The Core Integration)
Since developers already use the VS Code debugger, building this as a **VS Code Extension** using the **Debug Adapter Protocol (DAP)** is the most seamless approach.
- **Language**: TypeScript / Node.js
- **UI Components**: VS Code Webviews (React or Vue.js for the complex UI panels).

### 2. The User Interface (Webview Panels)
- **Center Panel (Execution Flow)**: A visual representation of the call stack and step-by-step execution path. We can use a library like `React Flow` to draw dynamic node-based execution graphs that update as the code steps.
- **Right Panel (Data State & AI Insights)**:
  - **Data Inspector**: A rich object tree view displaying current variable states (enhanced from the default VS Code variables pane).
  - **AI Auditor**: A section that streams insights, flagging hallucinations, checking code guidelines, and suggesting optimizations based on the current execution context.

### 3. AI Analysis Service
- **LLM Integration**: Use an LLM via API to analyze the static code alongside runtime data.
- **Guideline Engine**: A RAG (Retrieval-Augmented Generation) setup that stores the company's coding guidelines to check against the executed code.

---

## Proposed Implementation Plan

### Phase 1: Foundation & Debugger Hooks
- [x] Initialize a new VS Code Extension project (`yo code`).
- [x] Create basic Webview panels (Center and Right sidebars).
- [x] Implement a listener for VS Code's `vscode.debug` API to intercept debug sessions (breakpoints, steps, variable changes).

### Phase 2: User Interface Construction
- [ ] **React App Integration**: Set up React inside the Webview to handle complex state.
- [ ] **Center Panel**: Integrate `React Flow` to render execution steps. Map DAP (Debug Adapter Protocol) events (like `step over`, `step into`) to new nodes on the graph.
- [ ] **Right Panel**: Build a custom variable inspector that updates on every debug step.

### Phase 3: AI Analysis Integration
- [x] Connect the extension to the chosen LLM provider. *(Provider abstraction: config-selected `llm` (OpenAI-compatible) or dependency-free `heuristic` fallback; `ai-service/`.)*
- [x] Create a prompt pipeline that takes the current function's AST (Abstract Syntax Tree) + runtime variable state and asks the LLM:
  - "Does this code hallucinate APIs?"
  - "Is this optimal?"
  - "Does it follow standard guidelines?"
  - *(Implemented as `POST /audit`: frame + code + runtime variables + guidelines → confidence score + hallucination/optimality/guideline verdicts + findings, output-guarded to a strict schema.)*
- [x] Stream and display these insights in the Right Panel in real-time. *(Extension host POSTs on each debugger stop; webview AI Auditor panel renders the live verdict.)*

### Phase 4: Packaging and Deployment
- [ ] Configure `vsce` (VS Code Extension Manager) for packaging.
- [ ] Test on multiple OS (Mac, Windows, Linux).
- [ ] Publish to the Visual Studio Code Marketplace (or distribute internally via `.vsix` files for enterprise privacy).

---

## Verification Plan

### Automated Tests
- Unit tests for the DAP message interceptors to ensure we capture state correctly without crashing the main debug session.
- Run known "bad" AI code through the AI Analysis Service mock to ensure it catches hallucinations.

### Manual Verification
- Start a debugging session on a sample script.
- Verify that stepping through the code draws new flow nodes in the Center Panel.
- Verify the Right Panel updates variables and outputs an AI confidence score on the code block.
