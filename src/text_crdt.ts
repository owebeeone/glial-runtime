/**
 * The mounted `text_crdt.profile/v1` projection over Glade's CRDT op stream.
 *
 * Glade contributes durable op identity and causal `refs`; Taut's `CrdtNode`
 * owns delivery, deduplication, causal buffering, and the canonical text
 * projection. This module adds the editor-facing identity view needed to keep
 * selections anchored to elements instead of volatile string offsets.
 */

import {
  CrdtNode,
  encodeTextDelete,
  encodeTextInsert,
  projectText,
  type CrdtClock,
  type CrdtDiagnostic,
  type CrdtOp,
} from "@owebeeone/taut-shape";

import type { StoredOp } from "./store.ts";

export type TextAffinity = "before" | "after";

export interface TextElementId {
  readonly actor_id: string;
  readonly counter: number;
}

export interface TextCrdtElement {
  /** Public identity required by the editing contract. */
  readonly id: TextElementId;
  /** Canonical profile atom id carried in insert/delete payloads. */
  readonly atomId: string;
  readonly text: string;
  readonly deleted: boolean;
}

export interface TextCrdtState {
  readonly text: string;
  /** Tree order including tombstones, so deleted cursor anchors still resolve. */
  readonly elements: readonly TextCrdtElement[];
  readonly visible: readonly TextCrdtElement[];
  readonly clock: Readonly<Record<string, bigint>>;
  readonly diagnostics: readonly string[];
}

export interface TextCursorAnchor {
  readonly element: TextElementId | null;
  readonly affinity: TextAffinity;
}

export interface TextSelectionAnchor {
  readonly anchor: TextCursorAnchor;
  readonly focus: TextCursorAnchor;
}

export interface TextSelectionOffsets {
  readonly anchor: number;
  readonly focus: number;
}

export type TextEdit =
  | { readonly kind: "insert"; readonly atomId: string; readonly after: string | null; readonly text: string }
  | { readonly kind: "delete"; readonly atomId: string };

export class TextCrdtError extends Error {
  readonly code = "GLIAL_TEXT_CRDT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TextCrdtError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const COUNTER_WIDTH = String(MAX_COUNTER).length;

function diagnosticName(value: { readonly type: "diagnostic" } & CrdtDiagnostic): string {
  return `${value.code}:${value.origin ?? ""}:${value.seq ?? ""}`;
}

function checkedSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TextCrdtError(`text_crdt ${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Strict profile decode. Invalid UTF-8/JSON and non-canonical edit shapes are
 * rejected before an op reaches the instance store. */
export function decodeTextEdit(payload: Uint8Array): TextEdit {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
  } catch {
    throw new TextCrdtError("text_crdt payload must be canonical UTF-8 JSON");
  }
  const keys = Object.keys(value).sort().join();
  if (value.kind === "delete" && keys === "atom_id,kind" && typeof value.atom_id === "string" && value.atom_id.length > 0) {
    return { kind: "delete", atomId: value.atom_id };
  }
  if (
    value.kind === "insert"
    && keys === "after,atom_id,kind,text"
    && typeof value.atom_id === "string"
    && value.atom_id.length > 0
    && (value.after === null || typeof value.after === "string")
    && typeof value.text === "string"
    && value.text.length > 0
  ) {
    return { kind: "insert", atomId: value.atom_id, after: value.after as string | null, text: value.text };
  }
  throw new TextCrdtError("text_crdt payload is not an insert/delete profile operation");
}

export function encodeTextEdit(edit: TextEdit): Uint8Array {
  return edit.kind === "insert"
    ? encodeTextInsert(edit.atomId, edit.after, edit.text)
    : encodeTextDelete(edit.atomId);
}

/** Atom ids sort later same-actor insertions before older siblings. That is the
 * RGA insertion rule needed for a new middle insertion to precede the old
 * right-hand sibling while retaining `{actor_id,counter}` as public identity. */
export function textAtomId(id: TextElementId, insertionOrder = id.counter): string {
  if (id.actor_id.length === 0) throw new TextCrdtError("text_crdt actor_id must not be empty");
  if (!Number.isSafeInteger(id.counter) || id.counter <= 0) {
    throw new TextCrdtError("text_crdt element counter must be a positive safe integer");
  }
  if (!Number.isSafeInteger(insertionOrder) || insertionOrder <= 0) {
    throw new TextCrdtError("text_crdt insertion order must be a positive safe integer");
  }
  // Siblings with a later causal/Lamport rank sort first, placing a new middle
  // insertion before the older right-hand child regardless of actor. Concurrent
  // siblings share a rank and then sort deterministically by actor/counter.
  const reverse = String(MAX_COUNTER - insertionOrder).padStart(COUNTER_WIDTH, "0");
  return `${reverse}:${encodeURIComponent(id.actor_id)}:${id.counter}`;
}

function parseTextAtomId(atomId: string, fallbackActor: string, fallbackCounter: bigint): TextElementId {
  const match = /^(\d{16}):(.*):(\d+)$/.exec(atomId);
  if (match) {
    const counter = Number(match[3]);
    if (Number.isSafeInteger(counter) && counter > 0) {
      try {
        return { actor_id: decodeURIComponent(match[2]!), counter };
      } catch {
        // A foreign but valid text-profile atom remains anchorable below.
      }
    }
  }
  // Read the short-lived pre-rank adapter format for persisted developer data.
  const legacy = /^(.*):(\d{16}):(\d+)$/.exec(atomId);
  if (legacy) {
    const counter = Number(legacy[3]);
    if (Number.isSafeInteger(counter) && counter > 0) {
      try {
        return { actor_id: decodeURIComponent(legacy[1]!), counter };
      } catch {
        // Fall through to the operation identity.
      }
    }
  }
  const counter = Number(fallbackCounter);
  return {
    actor_id: fallbackActor,
    counter: Number.isSafeInteger(counter) && counter > 0 ? counter : 1,
  };
}

function elementKey(id: TextElementId): string {
  return `${id.actor_id}\x00${id.counter}`;
}

function baseSequences(ops: readonly StoredOp[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const op of ops) {
    const seq = checkedSequence(op.seq, "op seq");
    const prior = result.get(op.origin);
    if (prior === undefined || seq < prior) result.set(op.origin, seq);
  }
  return result;
}

function crdtSequence(origin: string, seq: number, bases: ReadonlyMap<string, number>): bigint {
  const base = bases.get(origin) ?? 0;
  return BigInt(checkedSequence(seq, "op seq") - base + 1);
}

function crdtClock(op: StoredOp, bases: ReadonlyMap<string, number>): CrdtClock {
  const byOrigin = new Map<string, bigint>();
  for (const ref of op.refs ?? []) {
    const seq = crdtSequence(ref.origin, ref.seq, bases);
    const prior = byOrigin.get(ref.origin) ?? 0n;
    if (seq > prior) byOrigin.set(ref.origin, seq);
  }
  return {
    entries: [...byOrigin]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([origin, seq]) => ({ origin, seq })),
  };
}

interface Atom {
  readonly after: string | null;
  readonly text: string;
  readonly key: readonly [string, bigint];
}

function atomCompare(left: Atom, right: Atom): number {
  const after = (left.after ?? "").localeCompare(right.after ?? "");
  if (after !== 0) return after;
  const text = left.text.localeCompare(right.text);
  if (text !== 0) return text;
  const origin = left.key[0].localeCompare(right.key[0]);
  return origin !== 0 ? origin : left.key[1] < right.key[1] ? -1 : left.key[1] > right.key[1] ? 1 : 0;
}

/** Assemble a store snapshot through the common CRDT node and text profile. */
export function assembleTextCrdt(ops: readonly StoredOp[]): TextCrdtState {
  const bases = baseSequences(ops);
  const node = new CrdtNode({ maxPending: Math.max(1024, ops.length) });
  const deliveryDiagnostics = new Set<string>();

  for (const stored of ops) {
    decodeTextEdit(stored.payload);
    const op: CrdtOp = {
      origin: stored.origin,
      seq: crdtSequence(stored.origin, stored.seq, bases),
      deps: crdtClock(stored, bases),
      payload: stored.payload,
    };
    for (const output of node.handle({ type: "apply", op })) {
      if (output.type === "diagnostic") deliveryDiagnostics.add(diagnosticName(output));
    }
  }

  const canonical = projectText(node);
  const atoms = new Map<string, Atom>();
  const deleted = new Set<string>();
  const diagnostics = new Set<string>([...deliveryDiagnostics, ...canonical.diagnostics]);

  for (const op of node.operations) {
    const edit = decodeTextEdit(op.payload);
    if (edit.kind === "delete") {
      deleted.add(edit.atomId);
      continue;
    }
    const candidate: Atom = { after: edit.after, text: edit.text, key: [op.origin, op.seq] };
    const prior = atoms.get(edit.atomId);
    if (prior && (prior.after !== candidate.after || prior.text !== candidate.text || prior.key[0] !== candidate.key[0] || prior.key[1] !== candidate.key[1])) {
      diagnostics.add(`atom_equivocation:${edit.atomId}`);
      if (atomCompare(candidate, prior) < 0) atoms.set(edit.atomId, candidate);
    } else {
      atoms.set(edit.atomId, candidate);
    }
  }

  const children = new Map<string | null, string[]>();
  for (const [atomId, atom] of atoms) {
    if (atom.after !== null && !atoms.has(atom.after)) {
      diagnostics.add(`missing_parent:${atomId}:${atom.after}`);
      continue;
    }
    const siblings = children.get(atom.after) ?? [];
    siblings.push(atomId);
    children.set(atom.after, siblings);
  }
  for (const siblings of children.values()) siblings.sort();

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const elements: TextCrdtElement[] = [];
  const visit = (atomId: string): void => {
    if (visiting.has(atomId)) {
      diagnostics.add(`cycle:${atomId}`);
      return;
    }
    if (visited.has(atomId)) return;
    visiting.add(atomId);
    const atom = atoms.get(atomId)!;
    elements.push({
      id: parseTextAtomId(atomId, atom.key[0], atom.key[1]),
      atomId,
      text: atom.text,
      deleted: deleted.has(atomId),
    });
    for (const child of children.get(atomId) ?? []) visit(child);
    visiting.delete(atomId);
    visited.add(atomId);
  };
  for (const root of children.get(null) ?? []) visit(root);
  for (const atomId of [...atoms.keys()].filter((id) => !visited.has(id)).sort()) {
    if (atoms.has(atoms.get(atomId)!.after!)) visit(atomId);
  }

  const visible = elements.filter((element) => !element.deleted);
  const text = visible.map((element) => element.text).join("");
  if (text !== canonical.text) {
    throw new TextCrdtError("text_crdt identity projection diverged from the canonical Taut projection");
  }
  return Object.freeze({
    text,
    elements: Object.freeze(elements),
    visible: Object.freeze(visible),
    clock: Object.freeze(Object.fromEntries(node.clock.entries.map((entry) => [entry.origin, entry.seq]))),
    diagnostics: Object.freeze([...diagnostics].sort()),
  });
}

interface ElementRange {
  readonly element: TextCrdtElement;
  readonly start: number;
  readonly end: number;
}

function codePointRanges(state: TextCrdtState): ElementRange[] {
  let offset = 0;
  return state.visible.map((element) => {
    const start = offset;
    offset += Array.from(element.text).length;
    return { element, start, end: offset };
  });
}

/** Identity edit plan for an arbitrary DOM text replacement. Existing elements
 * outside the changed span retain their ids; a legacy multi-character atom is
 * expanded only when an edit lands inside it. */
export function planTextReplacement(
  state: TextCrdtState,
  nextText: string,
  allocate: () => string,
): readonly TextEdit[] {
  if (nextText === state.text) return [];
  const previous = Array.from(state.text);
  const next = Array.from(nextText);
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  const oldEnd = previous.length - suffix;
  const ranges = codePointRanges(state);
  let affected = ranges.filter((range) => range.end > prefix && range.start < oldEnd);
  if (prefix === oldEnd) {
    const containing = ranges.find((range) => range.start < prefix && range.end > prefix);
    affected = containing ? [containing] : [];
  }
  const boundaryStart = affected[0]?.start ?? prefix;
  const boundaryEnd = affected.at(-1)?.end ?? oldEnd;
  const nextBoundaryEnd = next.length - (previous.length - boundaryEnd);
  const replacement = next.slice(boundaryStart, nextBoundaryEnd);
  const anchor = [...ranges].reverse().find((range) => range.end <= boundaryStart)?.element.atomId ?? null;

  const edits: TextEdit[] = affected.map((range) => ({ kind: "delete", atomId: range.element.atomId }));
  let after = anchor;
  for (const text of replacement) {
    const atomId = allocate();
    edits.push({ kind: "insert", atomId, after, text });
    after = atomId;
  }
  return edits;
}

function cursorAtOffset(state: TextCrdtState, rawOffset: number): TextCursorAnchor {
  const offset = Math.max(0, Math.min(state.text.length, rawOffset));
  if (state.visible.length === 0) return { element: null, affinity: "before" };
  let position = 0;
  for (const element of state.visible) {
    const end = position + element.text.length;
    if (offset === position && position === 0) return { element: element.id, affinity: "before" };
    if (offset <= end) {
      return { element: element.id, affinity: offset - position < end - offset ? "before" : "after" };
    }
    position = end;
  }
  return { element: state.visible.at(-1)!.id, affinity: "after" };
}

export function anchorSelection(state: TextCrdtState, selection: TextSelectionOffsets): TextSelectionAnchor {
  return {
    anchor: cursorAtOffset(state, selection.anchor),
    focus: cursorAtOffset(state, selection.focus),
  };
}

function resolveCursor(state: TextCrdtState, cursor: TextCursorAnchor): number {
  if (cursor.element === null) return cursor.affinity === "before" ? 0 : state.text.length;
  const target = elementKey(cursor.element);
  let offset = 0;
  for (const element of state.elements) {
    const before = offset;
    if (!element.deleted) offset += element.text.length;
    if (elementKey(element.id) === target) return cursor.affinity === "before" ? before : offset;
  }
  return cursor.affinity === "before" ? 0 : state.text.length;
}

export function resolveSelection(state: TextCrdtState, selection: TextSelectionAnchor): TextSelectionOffsets {
  return {
    anchor: resolveCursor(state, selection.anchor),
    focus: resolveCursor(state, selection.focus),
  };
}

export function nextTextCounter(state: TextCrdtState, actorId: string): number {
  return state.elements.reduce(
    (counter, element) => element.id.actor_id === actorId ? Math.max(counter, element.id.counter) : counter,
    0,
  ) + 1;
}

export function emptyTextCrdtState(): TextCrdtState {
  return Object.freeze({ text: "", elements: Object.freeze([]), visible: Object.freeze([]), clock: Object.freeze({}), diagnostics: Object.freeze([]) });
}
