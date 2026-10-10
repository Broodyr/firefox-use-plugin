// Undo handlers for change kinds owned by adapters (the undo tool). Core kinds (prefs, extension storage,
// add-on state, managed storage) are handled in tools/snapshots.ts; adapters register theirs here.
import type { Browser } from '../browser/session.js';

export interface Change { kind: string; path?: string; before?: unknown; after?: unknown }
export type UndoHandler = (b: Browser, c: Change) => Promise<{ line: string; change: Change }>;

export const UNDO_HANDLERS = new Map<string, UndoHandler>();

export function registerUndo(kind: string, h: UndoHandler) { UNDO_HANDLERS.set(kind, h); }
