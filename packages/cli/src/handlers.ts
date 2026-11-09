// Registers every headless role handler with the worker (worker.ts).
// Imported by the tax CLI entry; each module self-registers on import.
import "./fetch-handler.js";
import "./decision-handler.js";
import "./reviewer-handler.js";
