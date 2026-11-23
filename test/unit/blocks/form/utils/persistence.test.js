import { expect } from '@esm-bundle/chai';
import '../../../setup-nx.js';
import { attachPersistence } from '../../../../../blocks/form/utils/persistence.js';
import { createEngine } from '../../../../../deps/da-sc-sdk/dist/index.js';

// Minimal editor stub. `setValues(next)` simulates a real mutation by
// replacing `state.document` with a NEW reference — persistence uses
// reference equality on the document to detect mutations.
function makeEditor(initial = {}) {
  let state = {
    document: {
      metadata: { schemaName: 'demo' },
      data: initial,
    },
  };
  return {
    getState: () => state,
    setValues: (next) => {
      state = {
        document: {
          metadata: { schemaName: 'demo' },
          data: next,
        },
      };
    },
  };
}

// A controllable save stub. Returns a Promise that settles only when the test
// calls `release(callIndex, result)` or `fail(callIndex)`. Tracks every
// (path, html) call.
function makeSave() {
  const calls = [];
  const resolvers = [];
  const save = ({ path, html }) => new Promise((resolve, reject) => {
    calls.push({ path, html });
    resolvers.push({ resolve, reject });
  });
  return {
    save,
    calls,
    release: (i = calls.length - 1, result = { ok: true }) => resolvers[i].resolve(result),
    fail: (i = calls.length - 1, err = new Error('boom')) => resolvers[i].reject(err),
    settledCount: () => resolvers.length,
  };
}

const tick = () => new Promise((r) => { setTimeout(r, 0); });

describe('attachPersistence', () => {
  it('does not save when notify() is called with no mutation (same values reference)', async () => {
    const editor = makeEditor();
    const { save, calls } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    p.notify();
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(0);
    p.detach();
  });

  it('saves once after a mutation', async () => {
    const editor = makeEditor();
    const { save, calls, release } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.setValues({ a: 1 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].path).to.equal('/x');
    expect(calls[0].html).to.include('demo');
    release();
    p.detach();
  });

  it('coalesces concurrent mutations during an in-flight save (single-flight + re-queue)', async () => {
    // Critical contract: mid-flight notifies don't fire concurrent saves;
    // they set `pending` so a SECOND save runs after the first settles, with
    // the LATEST values. Prevents out-of-order overwrites on slow networks.
    const editor = makeEditor();
    const { save, calls, release } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.setValues({ a: 1 });
    p.notify(); // → save #1 starts (call 0)
    await tick();
    expect(calls).to.have.lengthOf(1);

    editor.setValues({ a: 2 });
    p.notify(); // mid-flight: should NOT start save #2 yet
    editor.setValues({ a: 3 });
    p.notify(); // still mid-flight: still pending
    await tick();
    expect(calls).to.have.lengthOf(1); // still one — no concurrent save

    release(0); // save #1 settles
    await tick();
    // After settle, the loop re-iterates because pending is true. The
    // second save reads the LATEST state — should serialize a:3, not a:2.
    expect(calls).to.have.lengthOf(2);
    expect(calls[1].html).to.include('>3<'); // latest value present
    expect(calls[1].html).to.not.include('>2<'); // intermediate never serialized
    release(1);
    await tick();

    // No further saves — pending was cleared at the second iteration.
    editor.setValues({ a: 4 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(3); // third save fires fresh
    release(2);
    p.detach();
  });

  it('detach() prevents subsequent saves', async () => {
    const editor = makeEditor();
    const { save, calls } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    p.detach();
    editor.setValues({ a: 1 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(0);
  });

  it('detach() mid-flight lets the current save settle without crashing', async () => {
    const editor = makeEditor();
    const { save, calls, release } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.setValues({ a: 1 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(1);

    p.detach(); // detach while save in flight
    editor.setValues({ a: 2 });
    p.notify(); // ignored — detached
    release(0);
    await tick();
    // Only the in-flight save settles; no re-iteration because the detached
    // notify never set `pending`.
    expect(calls).to.have.lengthOf(1);
  });

  it('does not retry on its own when save throws; the next mutation saves again', async () => {
    const editor = makeEditor();
    const { save, calls, fail } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.setValues({ a: 1 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(1);

    fail(0);
    await tick();
    expect(calls).to.have.lengthOf(1);

    editor.setValues({ a: 2 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(2);
    p.detach();
  });

  it('skips the save when convertJsonToHtml returns an error (no schemaName)', async () => {
    // Document with no schemaName fails the SDK's convertJsonToHtml validation.
    // Persistence must NOT try to save — and must not loop forever waiting
    // for a fix. (`pending` is cleared even when convertJsonToHtml errors.)
    const editor = {
      _state: { document: { metadata: {}, data: { a: 1 } } },
      getState() { return this._state; },
      mutate(next) {
        this._state = { document: { metadata: {}, data: next } };
      },
    };
    const { save, calls } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.mutate({ a: 2 });
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(0);

    // Mutating to a valid doc should now save normally.
    editor._state = { document: { metadata: { schemaName: 'demo' }, data: { a: 3 } } };
    p.notify();
    await tick();
    expect(calls).to.have.lengthOf(1);
    p.detach();
  });

  it('writes a rich-text value into a block of its own', async () => {
    const schema = {
      type: 'object',
      properties: { body: { type: 'string', 'x-semantic-type': 'rich-text' } },
    };
    const editor = createEngine({
      schema,
      document: { metadata: { schemaName: 'demo' }, data: {} },
    });
    const { save, calls, release } = makeSave();
    const p = attachPersistence(editor, { path: '/x', save });

    editor.setField('/data/body', '<p>Hello <strong>bold</strong></p>');
    p.notify();
    await tick();
    expect(calls[0].html).to.include('self://rich-text#body-1');
    expect(calls[0].html).to.include('<p>Hello <strong>bold</strong></p>');
    release();
    p.detach();
  });

  describe('flush()', () => {
    it('resolves ok without saving when nothing changed', async () => {
      const { save, calls } = makeSave();
      const p = attachPersistence(makeEditor(), { path: '/x', save });
      expect(await p.flush()).to.deep.equal({ ok: true });
      expect(calls).to.have.lengthOf(0);
    });

    it('waits for the in-flight save and its coalesced follow-up', async () => {
      const editor = makeEditor();
      const { save, calls, release } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      editor.setValues({ a: 2 });
      p.notify();
      let result;
      p.flush().then((r) => { result = r; });

      release(0);
      await tick();
      expect(result).to.equal(undefined);
      expect(calls).to.have.lengthOf(2);
      release(1);
      await tick();
      expect(result).to.deep.equal({ ok: true });
    });

    it('reports the error and status a failed save resolves', async () => {
      const editor = makeEditor();
      const { save, release } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      const flushed = p.flush();
      release(0, { error: 'Could not save source document.', status: 500 });
      const failure = { ok: false, error: 'Could not save source document.', status: 500 };
      expect(await flushed).to.deep.equal(failure);
    });

    it('reports a save that resolves without ok, such as a signed-out {}', async () => {
      const editor = makeEditor();
      const { save, release } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      const flushed = p.flush();
      release(0, {});
      expect(await flushed).to.deep.equal({ ok: false, error: 'Could not save source document.' });
    });

    it('reports a thrown save error', async () => {
      const editor = makeEditor();
      const { save, fail } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      const flushed = p.flush();
      fail(0, new Error('offline'));
      expect(await flushed).to.deep.equal({ ok: false, error: 'offline' });
    });

    it('reports a conversion error without saving', async () => {
      const editor = makeEditor();
      const { save, calls } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      editor.getState().document.metadata = {};
      p.notify();
      const result = await p.flush();
      expect(result.ok).to.equal(false);
      expect(result.error).to.match(/^Could not convert document to HTML/);
      expect(calls).to.have.lengthOf(0);
    });

    it('sends unsaved edits again after a failed save', async () => {
      const editor = makeEditor();
      const { save, calls, release } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      release(0, { error: 'Could not save source document.', status: 503 });
      await tick();

      const flushed = p.flush();
      await tick();
      expect(calls).to.have.lengthOf(2);
      expect(calls[1].html).to.include('>1<');
      release(1);
      expect(await flushed).to.deep.equal({ ok: true });
    });

    it('does not start a save after detach()', async () => {
      const editor = makeEditor();
      const { save, calls, release } = makeSave();
      const p = attachPersistence(editor, { path: '/x', save });

      editor.setValues({ a: 1 });
      p.notify();
      release(0, { error: 'Could not save source document.' });
      await tick();
      p.detach();

      expect((await p.flush()).ok).to.equal(false);
      expect(calls).to.have.lengthOf(1);
    });
  });

  describe('onError', () => {
    it('reports once per run of failures and again after a successful save', async () => {
      const editor = makeEditor();
      const { save, release } = makeSave();
      const errors = [];
      const p = attachPersistence(editor, { path: '/x', save, onError: (e) => errors.push(e) });
      const failure = { error: 'Could not save source document.', status: 500 };

      editor.setValues({ a: 1 });
      p.notify();
      release(0, failure);
      await tick();
      editor.setValues({ a: 2 });
      p.notify();
      release(1, failure);
      await tick();
      expect(errors).to.deep.equal([{ ok: false, ...failure }]);

      editor.setValues({ a: 3 });
      p.notify();
      release(2);
      await tick();
      editor.setValues({ a: 4 });
      p.notify();
      release(3, failure);
      await tick();
      expect(errors).to.have.lengthOf(2);
      p.detach();
    });
  });
});
