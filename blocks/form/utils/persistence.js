// Persistence for the form block.
//
// At most one save runs at a time. Edits made during a save are coalesced
// into one follow-up save of the latest document, so saves never overwrite
// each other out of order.
//
// Usage:
//   const editor = createEngine({ schema, document, onChange });
//   const persistence = attachPersistence(editor, { path, onError });
//   // ...in the shell's onChange handler:
//   persistence.notify();
//   const { ok, error, status } = await persistence.flush();
//   persistence.detach();   // on teardown
//
// `save` is injectable so the call is testable in isolation. The default is
// the form block's `saveSourceHtml`.

import { convertJsonToHtml } from '../../../deps/da-sc-sdk/dist/index.js';
import { saveSourceHtml } from './da-api.js';

const SAVED = Object.freeze({ ok: true });
const SAVE_FAILED = 'Could not save source document.';
const CONVERT_FAILED = 'Could not convert document to HTML';

function toFailure(result) {
  const failure = { ok: false, error: result?.error ?? SAVE_FAILED };
  if (result?.status) failure.status = result.status;
  return failure;
}

async function saveDocument({ document, model, path, save }) {
  try {
    // The model lets the SDK write each rich-text value into a block of its own.
    const { html, error } = convertJsonToHtml({ json: document, model });
    if (error) return { ok: false, error: `${CONVERT_FAILED}: ${error}` };
    const result = await save({ path, html });
    return result?.ok ? SAVED : toFailure(result);
  } catch (thrown) {
    return { ok: false, error: thrown?.message ?? SAVE_FAILED };
  }
}

export function attachPersistence(editor, { path, save = saveSourceHtml, onError } = {}) {
  let latestDocument = editor.getState()?.document;
  let revision = 0;
  let savedRevision = 0;
  let lastResult = SAVED;
  let failureReported = false;
  let pending = false;
  let inFlight = null;
  let detached = false;

  function record(result, sentRevision) {
    lastResult = result;
    if (result.ok) {
      savedRevision = Math.max(savedRevision, sentRevision);
      failureReported = false;
      return;
    }
    // One report per run of failures, so typing while offline doesn't toast every keystroke.
    if (!failureReported) {
      failureReported = true;
      onError?.(result);
    }
  }

  async function saveLatestDocument() {
    try {
      do {
        pending = false;
        const sentRevision = revision;
        const { model } = editor.getState();
        const result = await saveDocument({ document: latestDocument, model, path, save });
        record(result, sentRevision);
      } while (pending);
    } finally {
      inFlight = null;
    }
  }

  function persist() {
    if (inFlight) {
      pending = true;
    } else {
      inFlight = saveLatestDocument();
    }
    return inFlight;
  }

  return {
    // mutate.js clones the document on every change, so a new reference means new content.
    notify: () => {
      if (detached) return;
      const next = editor.getState()?.document;
      if (next === latestDocument) return;
      latestDocument = next;
      revision += 1;
      persist();
    },
    // Waits for autosave to go idle and reports whether the document as of
    // this call is saved. Unsaved edits are sent again unless detached.
    flush: async () => {
      const target = revision;
      const isSaved = () => savedRevision >= target;
      if (isSaved()) return SAVED;
      if (inFlight) await inFlight;
      else if (!detached) await persist();
      return isSaved() ? SAVED : lastResult;
    },
    detach: () => { detached = true; },
  };
}
