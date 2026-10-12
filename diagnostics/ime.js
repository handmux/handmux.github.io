/* Isolated IME recorder. No product input handlers, backend or persistence. */
(function () {
  'use strict';
  const VERSION = '5.5.0';
  const MAX_EVENTS = 2000;
  const MAX_TEXT = 2048;
  // Exact published 5.5.0 UMD method. A changed build disables only the probe.
  const TIMER_SOURCE = '_handleAnyTextareaChanges(){const e=this._textarea.value;setTimeout((()=>{if(!this._isComposing){const t=this._textarea.value,i=t.replace(e,"");this._dataAlreadySent=i,t.length>e.length?this._coreService.triggerDataEvent(i,!0):t.length<e.length?this._coreService.triggerDataEvent(`${a.C0.DEL}`,!0):t.length===e.length&&t!==e&&this._coreService.triggerDataEvent(t,!0)}}),0)}';
  const identities = new WeakMap();
  let nextIdentity = 0;
  function identity(node) {
    if (!node) return null;
    if (!identities.has(node)) identities.set(node, `h${++nextIdentity}`);
    return identities.get(node);
  }
  const clip = value => typeof value === 'string' ? value.slice(0, MAX_TEXT) : value;

  function create(terminal, { version = VERSION, onData = () => {} } = {}) {
    const textarea = terminal.textarea;
    const helper = terminal._core?._compositionHelper;
    const original = helper?._handleAnyTextareaChanges;
    const available = version === VERSION && helper?._textarea === textarea &&
      typeof original === 'function' && original.toString() === TIMER_SOURCE;
    const helperId = identity(helper);
    const textareaId = identity(textarea);
    const startedAt = new Date().toISOString();
    const origin = performance.now();
    const events = new Array(MAX_EVENTS);
    let size = 0;
    let start = 0;
    let dropped = 0;
    let sequence = 0;
    let timerSequence = 0;
    let activeTimer = null;
    let recording = true;
    let restoreProbe = null;
    let probeGeneration = 0;
    const removers = [];

    function record(kind, fields) {
      if (!recording) return;
      const entry = { seq: ++sequence, ms: performance.now() - origin, kind, ...fields };
      if (size === MAX_EVENTS) {
        events[start] = entry;
        start = (start + 1) % MAX_EVENTS;
        dropped++;
      } else events[(start + size++) % MAX_EVENTS] = entry;
    }
    function state() {
      return {
        helperId, textareaId,
        helperMatchesTextarea: helper?._textarea === terminal.textarea,
        isComposing: helper?._isComposing ?? null,
        pendingComposition: helper?._isSendingComposition ?? null,
        dataAlreadySent: clip(helper?._dataAlreadySent),
        compositionStart: helper?._compositionPosition?.start ?? null,
        compositionEnd: helper?._compositionPosition?.end ?? null,
        keyDownSeen: terminal._core?._keyDownSeen ?? null,
        keyPressHandled: terminal._core?._keyPressHandled ?? null,
        value: clip(textarea.value), valueLength: textarea.value.length,
        selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd,
        focused: document.activeElement === textarea,
      };
    }

    function setProbe(enabled) {
      probeGeneration++;
      if (restoreProbe) { restoreProbe(); restoreProbe = null; }
      if (!recording || !enabled || !available) {
        record('probe-state', { enabled: false, available });
        return;
      }
      const generation = probeGeneration;
      const ownDescriptor = Object.getOwnPropertyDescriptor(helper, '_handleAnyTextareaChanges');
      function wrappedMethod(...args) {
        const nativeTimer = window.setTimeout;
        const oldValue = this._textarea.value;
        const scheduledState = state();
        // Intercept only the timer synchronously scheduled by this exact upstream
        // method, then restore setTimeout before returning to the DOM event loop.
        function observeTimer(callback, delay, ...timerArgs) {
          const timerId = ++timerSequence;
          const scheduledAt = performance.now() - origin;
          const result = Reflect.apply(nativeTimer, window, [function (...callbackArgs) {
            const observing = recording && probeGeneration === generation;
            const previousTimer = activeTimer;
            if (observing) {
              activeTimer = timerId;
              record('timer-fired', {
                timerId, scheduledAt, oldValue: clip(oldValue), oldValueLength: oldValue.length,
                newValue: clip(helper._textarea.value), newValueLength: helper._textarea.value.length,
                ...state(),
              });
            }
            try { return Reflect.apply(callback, this, callbackArgs); }
            finally { activeTimer = previousTimer; }
          }, delay, ...timerArgs]);
          record('timer-scheduled', {
            timerId, scheduledAt, delay, oldValue: clip(oldValue), oldValueLength: oldValue.length,
            ...scheduledState,
          });
          return result;
        }
        window.setTimeout = observeTimer;
        try { return Reflect.apply(original, this, args); }
        finally { window.setTimeout = nativeTimer; }
      }
      helper._handleAnyTextareaChanges = wrappedMethod;
      restoreProbe = () => {
        if (helper._handleAnyTextareaChanges !== wrappedMethod) return;
        if (ownDescriptor) Object.defineProperty(helper, '_handleAnyTextareaChanges', ownDescriptor);
        else delete helper._handleAnyTextareaChanges;
      };
      record('probe-state', { enabled: true, available });
    }

    for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'focus', 'blur', 'paste']) {
      for (const capture of [true, false]) {
        const listener = event => record('dom', {
          type, phase: capture ? 'capture' : 'bubble', trusted: event.isTrusted,
          composed: event.composed, cancelable: event.cancelable,
          eventTimeStamp: event.timeStamp, data: clip(event.data), dataLength: event.data?.length,
          inputType: clip(event.inputType), eventIsComposing: event.isComposing ?? null,
          key: clip(event.key), code: clip(event.code), keyCode: event.keyCode,
          charCode: event.charCode, which: event.which,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          defaultPrevented: event.defaultPrevented, ...state(),
        });
        textarea.addEventListener(type, listener, capture);
        removers.push(() => textarea.removeEventListener(type, listener, capture));
      }
    }
    const dataSubscription = terminal.onData(data => {
      record('onData', { data: clip(data), dataLength: data.length, timerId: activeTimer, ...state() });
      onData(data);
    });
    setProbe(true);
    record('start', { ...state(), probeAvailable: available });

    return {
      setProbe,
      stop() {
        if (!recording) return;
        record('stop', state());
        setProbe(false);
        recording = false;
        for (const remove of removers) remove();
        removers.length = 0;
        dataSubscription.dispose();
        // Already queued upstream callbacks still run exactly once, with logging
        // disabled. Cancelling them would change xterm's input behavior.
      },
      clear() { events.fill(undefined); start = 0; size = 0; dropped = 0; },
      snapshot() {
        return {
          schema: 1, xtermVersion: version, startedAt, exportedAt: new Date().toISOString(),
          userAgent: clip(navigator.userAgent), language: clip(navigator.language),
          recording, probeAvailable: available, probeEnabled: Boolean(restoreProbe),
          maxEvents: MAX_EVENTS, maxTextLength: MAX_TEXT, dropped,
          events: Array.from({ length: size }, (_, index) => ({ ...events[(start + index) % MAX_EVENTS] })),
        };
      },
    };
  }
  window.IMEDiagnostic = { create };

  function boot() {
    const host = document.getElementById('ime-terminal');
    if (!host) return;
    const status = document.getElementById('status');
    const probe = document.getElementById('probe');
    const output = document.getElementById('output');
    const terminal = new window.Terminal({ cols: 40, rows: 9, fontSize: 16, cursorBlink: true, theme: { background: '#101318' } });
    terminal.open(host);
    terminal.writeln('IME test — click here, then type.');
    terminal.writeln('No server / no local echo.');
    const recorder = create(terminal, { onData: data => { output.textContent = JSON.stringify(clip(data)); } });
    if (!recorder.snapshot().probeAvailable) {
      probe.checked = false;
      probe.disabled = true;
      status.textContent = '探针校验未通过；仍可测试原版 xterm 并导出 DOM / onData 日志。';
    }
    probe.addEventListener('change', () => recorder.setProbe(probe.checked));
    const stop = document.getElementById('stop');
    stop.addEventListener('click', () => {
      recorder.stop();
      stop.disabled = true;
      probe.disabled = true;
      status.textContent = '记录已停止，探针和记录监听已撤销。仍可导出或清空已有日志。重新加载开始新测试。';
    });
    document.getElementById('clear').addEventListener('click', () => {
      recorder.clear();
      output.textContent = '尚无数据';
      status.textContent = recorder.snapshot().recording ? '日志已清空，继续记录。' : '日志已清空，记录已停止。';
    });
    document.getElementById('export').addEventListener('click', () => {
      const dump = recorder.snapshot();
      const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `xterm-ime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Retain one download URL until the next export or unload; no extra timer.
      if (boot.downloadURL) URL.revokeObjectURL(boot.downloadURL);
      boot.downloadURL = url;
      status.textContent = `已导出 ${dump.events.length} 条日志；较早日志丢弃 ${dump.dropped} 条。`;
    });
    window.addEventListener('pagehide', () => {
      recorder.stop();
      terminal.dispose();
      if (boot.downloadURL) URL.revokeObjectURL(boot.downloadURL);
    }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
